// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import assert from 'node:assert/strict'
import test from 'node:test'
import { WebProviderError } from '../dist/web.js'
import { createDeepSeekWebProvider } from '../dist/web/deepseek.js'

const key = 'private-test-key'
const url = 'https://example.test/article?secret=private-url'
const query = 'private-query'
const item = { title: 'Article', url, snippet: 'Short', summary: 'Long', content: '' }
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const factory = (fetch, options = {}) => createDeepSeekWebProvider({ apiKey: key, fetch, ...options })

function sanitized(caught, code, state, apiStatus) {
  assert(caught instanceof WebProviderError)
  assert.equal(caught.provider, 'deepseek')
  assert.equal(caught.code, code)
  assert.equal(caught.requestState, state)
  assert.equal(caught.apiStatus, apiStatus)
  assert.equal(caught.name, code === 'aborted' ? 'AbortError' : 'WebProviderError')
  assert.equal(caught.cause, undefined)
  const serialized = JSON.stringify(caught) + String(caught) + caught.stack
  for (const secret of [key, url, query, 'UPSTREAM_SECRET']) assert(!serialized.includes(secret))
  return true
}

test('search uses the fixed standalone endpoint, minimal body, key callback and no model selection', async () => {
  const requests = []
  let keys = 0
  const provider = factory(async (endpoint, init) => {
    requests.push([endpoint, init])
    return json({ results: [item], ignored: 'not retained' })
  }, { apiKey: async () => { keys++; return key }, baseURL: 'https://hostile.test', model: 'ignored' })
  assert.equal(provider.id, 'deepseek')
  const before = Date.now()
  const output = await provider.search({ query, ori_question: 'private original', localization: '127.0.0.1', apiKey: 'wrong' })
  assert.equal(keys, 1)
  assert.equal(requests.length, 1)
  const [endpoint, init] = requests[0]
  assert.equal(endpoint, 'https://api.deepseek.com/v1/tools/search')
  assert.equal(init.method, 'POST')
  assert.deepEqual(init.headers, { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' })
  assert.deepEqual(JSON.parse(init.body), { query, count: 10, need_content: false })
  assert.equal(init.redirect, 'error')
  assert.equal(init.credentials, 'omit')
  assert.equal(init.referrerPolicy, 'no-referrer')
  assert(init.signal instanceof AbortSignal)
  assert.deepEqual(output.results, [{ ...item, localTruncation: [] }])
  assert.equal(output.resultLimitApplied, false)
  assert.deepEqual(Object.keys(output.provenance).sort(), ['operation', 'provider', 'retrievedAt', 'untrusted', 'upstreamTruncation'])
  assert.equal(output.provenance.provider, 'deepseek')
  assert.equal(output.provenance.operation, 'search')
  assert.equal(output.provenance.untrusted, true)
  assert.equal(output.provenance.upstreamTruncation, 'unknown')
  assert(Date.parse(output.provenance.retrievedAt) >= before)
})

test('search preserves Unicode query operators and enforces 128 Unicode code points', async () => {
  const seen = []
  const provider = factory(async (_, init) => { seen.push(JSON.parse(init.body)); return json({ results: [] }) })
  await provider.search({ query: '😀'.repeat(128), count: 50, includeContent: true })
  const syntax = '  Vivi site:github.com OR site:example.org -ad "quoted phrase" lang:zh  '
  await provider.search({ query: syntax, count: 1 })
  assert.equal(seen[0].query, '😀'.repeat(128))
  assert.equal(seen[0].need_content, true)
  assert.equal(seen[1].query, syntax)
  for (const input of [null, {}, { query: '' }, { query: '\t\n ' }, { query: '😀'.repeat(129) },
    { query, count: 0 }, { query, count: 51 }, { query, count: 1.1 }, { query, count: NaN },
    { query, count: '2' }, { query, count: null }, { query, includeContent: 1 }]) {
    await assert.rejects(provider.search(input), caught => sanitized(caught, 'invalid_request', 'not_started'))
  }
  assert.equal(seen.length, 2)
})

test('fetch returns Markdown and requested URL with honest remote provenance only', async () => {
  const requests = []
  const provider = factory(async (endpoint, init) => {
    requests.push([endpoint, JSON.parse(init.body)])
    return json({ title: 'Remote title', content: '# Remote content', status: 200, finalUrl: 'https://unverified.test' })
  })
  const output = await provider.fetch({ url })
  assert.deepEqual(requests, [['https://api.deepseek.com/v1/tools/fetch', { url }]])
  assert.equal(output.requestedUrl, url)
  assert.equal(output.title, 'Remote title')
  assert.equal(output.contentMarkdown, '# Remote content')
  assert.deepEqual(output.localTruncation, [])
  assert.equal(output.provenance.operation, 'fetch')
  for (const unavailable of ['status', 'finalUrl', 'finalURL', 'bodyHash', 'javascriptExecuted']) assert(!(unavailable in output))
})

test('URL validation rejects credentials, malformed URLs, controls and non-HTTP schemes before transport', async () => {
  let calls = 0
  const provider = factory(async () => { calls++; return json({ title: '', content: '' }) })
  for (const invalid of ['', ' https://example.test', 'https://example.test ', 'file:///tmp/test', 'javascript:alert(1)',
    'https://user@example.test', 'https://:pass@example.test', 'https://u:p@example.test', 'https://@example.test', 'https://',
    'https:example.test', 'https://example.test/\npath', 'https://example.test\\path', 'https://example.test/' + 'x'.repeat(8192), 1, null]) {
    await assert.rejects(provider.fetch({ url: invalid }), caught => sanitized(caught, 'invalid_request', 'not_started'))
  }
  await provider.fetch({ url: 'http://example.test:8080/a?q=hello%20world#part' })
  const exact = 'https://example.test/' + 'x'.repeat(8192 - 'https://example.test/'.length)
  await provider.fetch({ url: exact })
  assert.equal(calls, 2)
})

test('bounded normalized results identify local field truncation without claiming upstream completeness', async () => {
  const expanded = { ...item, title: '😀'.repeat(2049), snippet: 's'.repeat(4097), summary: 'l'.repeat(8193), content: 'A😀B😀C' }
  const provider = factory(async () => json({ results: [expanded, item] }), { maxContentChars: 4 })
  const result = await provider.search({ query, count: 1, includeContent: true })
  assert.equal(result.results.length, 1)
  assert.equal(result.resultLimitApplied, true)
  assert.equal(Array.from(result.results[0].title).length, 2048)
  assert.equal(result.results[0].snippet.length, 4096)
  assert.equal(result.results[0].summary.length, 8192)
  assert.equal(result.results[0].content, 'A😀B😀')
  assert.deepEqual(result.results[0].localTruncation, ['title', 'snippet', 'summary', 'content'])
  assert.equal(result.provenance.upstreamTruncation, 'unknown')
  const page = await factory(async () => json({ title: 't'.repeat(2049), content: '😀😀😀' }), { maxContentChars: 2 }).fetch({ url })
  assert.equal(page.contentMarkdown, '😀😀')
  assert.deepEqual(page.localTruncation, ['title', 'contentMarkdown'])
})

test('empty successful output remains empty, never fabricated or retried', async () => {
  const searched = await factory(async () => json({ results: [] })).search({ query })
  assert.deepEqual(searched.results, [])
  const fetched = await factory(async () => json({ title: '', content: '' })).fetch({ url })
  assert.equal(fetched.title, '')
  assert.equal(fetched.contentMarkdown, '')
})

test('invalid API payloads are rejected without retaining data', async () => {
  for (const response of [null, [], {}, { results: null }, { results: [{}] }, { results: [{ ...item, url: 'javascript:bad' }] },
    { results: [{ ...item, content: null }] }, { results: [{ ...item, summary: 4 }] }]) {
    await assert.rejects(factory(async () => json(response)).search({ query }), caught => sanitized(caught, 'invalid_response', 'response_received'))
  }
  for (const response of [null, [], {}, { title: '', content: 4 }, { title: null, content: '' }]) {
    await assert.rejects(factory(async () => json(response)).fetch({ url }), caught => sanitized(caught, 'invalid_response', 'response_received'))
  }
  for (const response of [new Response('UPSTREAM_SECRET'), new Response(new Uint8Array([0xff]))]) {
    await assert.rejects(factory(async () => response).fetch({ url }), caught => sanitized(caught, 'invalid_response', 'response_received'))
  }
})

test('API HTTP failures are sanitized, tagged API-only, and never automatically retried', async () => {
  for (const status of [201, 400, 401, 402, 403, 404, 408, 413, 429, 500, 504]) {
    let calls = 0
    let cancelled = false
    const body = new ReadableStream({ pull() {}, cancel() { cancelled = true } })
    await assert.rejects(factory(async () => { calls++; return new Response(body, { status }) }).fetch({ url }),
      caught => sanitized(caught, 'http', 'response_received', status))
    assert.equal(calls, 1)
    assert.equal(cancelled, true)
  }
})

test('redirect responses cannot trigger a second request or forward the key to another origin', async () => {
  const seen = []
  const provider = factory(async (endpoint, init) => {
    seen.push(endpoint)
    assert.equal(new URL(endpoint).origin, 'https://api.deepseek.com')
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.Authorization, `Bearer ${key}`)
    return new Response('', { status: 302, headers: { Location: 'https://credential-sink.test/' } })
  })
  await assert.rejects(provider.fetch({ url, baseURL: 'https://credential-sink.test/', apiKey: 'untrusted' }),
    caught => sanitized(caught, 'http', 'response_received', 302))
  assert.deepEqual(seen, ['https://api.deepseek.com/v1/tools/fetch'])
})

test('bounded response reads enforce streamed and declared byte limits and cancel', async () => {
  let cancelled = false
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('12345678901')) }, cancel() { cancelled = true } })
  await assert.rejects(factory(async () => new Response(body), { maxResponseBytes: 10 }).fetch({ url }),
    caught => sanitized(caught, 'response_too_large', 'response_received'))
  assert.equal(cancelled, true)
  await assert.rejects(factory(async () => new Response('{}', { headers: { 'content-length': '11' } }), { maxResponseBytes: 10 }).fetch({ url }),
    caught => sanitized(caught, 'response_too_large', 'response_received'))
  const wire = JSON.stringify({ title: '😀', content: '中' })
  const bytes = new TextEncoder().encode(wire)
  const fragmented = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } })
  assert.equal((await factory(async () => new Response(fragmented), { maxResponseBytes: bytes.length }).fetch({ url })).contentMarkdown, '中')
})

test('factory validates trusted config and sanitized credential failures happen before transport', async () => {
  for (const options of [null, {}, { apiKey: '' }, { apiKey: '\nsecret' }, { apiKey: key, fetch: 4 },
    { apiKey: key, timeoutMs: 0 }, { apiKey: key, timeoutMs: Infinity }, { apiKey: key, maxResponseBytes: 16_777_217 },
    { apiKey: key, maxContentChars: 1_000_001 }, { apiKey: key, maxContentChars: 1.5 }, { apiKey: key, beforeRequest: true }]) {
    assert.throws(() => createDeepSeekWebProvider(options), caught => sanitized(caught, 'configuration', 'not_started'))
  }
  let calls = 0
  for (const apiKey of [() => { throw Error(key) }, async () => { throw Error(key) }, () => null, () => '']) {
    await assert.rejects(factory(async () => { calls++; return json({}) }, { apiKey }).fetch({ url }),
      caught => sanitized(caught, 'configuration', 'not_started'))
  }
  assert.equal(calls, 0)
})

test('pre-abort and credential timeout never start a request', async () => {
  let calls = 0
  let keys = 0
  const controller = new AbortController()
  controller.abort(Error('UPSTREAM_SECRET'))
  const provider = factory(async () => { calls++; return json({}) }, { apiKey: () => { keys++; return key } })
  await assert.rejects(provider.fetch({ url }, controller.signal), caught => sanitized(caught, 'aborted', 'not_started'))
  assert.equal(keys, 0)
  await assert.rejects(factory(async () => { calls++; return json({}) }, { apiKey: () => new Promise(() => {}), timeoutMs: 10 }).fetch({ url }),
    caught => sanitized(caught, 'timeout', 'not_started'))
  assert.equal(calls, 0)
})

test('transport throws and ignored aborts have uncertain request outcome and no retry', async () => {
  let calls = 0
  await assert.rejects(factory(() => { calls++; throw Error(key + url) }).fetch({ url }),
    caught => sanitized(caught, 'transport', 'unknown'))
  await assert.rejects(factory(async () => { calls++; return new Promise(() => {}) }, { timeoutMs: 10 }).fetch({ url }),
    caught => sanitized(caught, 'timeout', 'unknown'))
  const controller = new AbortController()
  const pending = factory(async () => { calls++; controller.abort(Error('UPSTREAM_SECRET')); return new Promise(() => {}) }).fetch({ url }, controller.signal)
  await assert.rejects(pending, caught => sanitized(caught, 'aborted', 'unknown'))
  assert.equal(calls, 3)
})

test('caller-created errors from credential or transport callbacks cannot escape sanitization', async () => {
  await assert.rejects(factory(async () => { throw new WebProviderError(key, 'http', url) }).fetch({ url }),
    caught => sanitized(caught, 'transport', 'unknown'))
  await assert.rejects(factory(async () => json({}), { apiKey: () => { throw new WebProviderError(key, 'transport', url) } }).fetch({ url }),
    caught => sanitized(caught, 'configuration', 'not_started'))
})

test('an earlier request error cannot forge a later transport or body-read outcome', async () => {
  let previous
  try { await factory(async () => new Response('', { status: 401 })).fetch({ url }) } catch (caught) { previous = caught }
  assert.equal(previous.code, 'http')
  await assert.rejects(factory(() => { throw previous }).fetch({ url }),
    caught => caught !== previous && sanitized(caught, 'transport', 'unknown'))
  await assert.rejects(factory(async () => { throw previous }).fetch({ url }),
    caught => caught !== previous && sanitized(caught, 'transport', 'unknown'))
  await assert.rejects(factory(async () => new Response(new ReadableStream({ start(controller) { controller.error(previous) } }))).fetch({ url }),
    caught => caught !== previous && sanitized(caught, 'invalid_response', 'response_received'))
})

test('trusted beforeRequest sees frozen normalized intent and blocks dispatch until durable intent is ready', async () => {
  const order = []
  let release
  let started
  const ready = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const provider = factory(async (_, init) => {
    order.push('transport')
    assert.deepEqual(JSON.parse(init.body), { query, count: 10, need_content: false })
    return json({ results: [] })
  }, {
    apiKey: async () => { order.push('credentials'); return key },
    beforeRequest: async (intent, signal) => {
      order.push('intent')
      assert.deepEqual(intent, { provider: 'deepseek', operation: 'search', request: { query, count: 10, includeContent: false } })
      assert(Object.isFrozen(intent))
      assert(Object.isFrozen(intent.request))
      assert.throws(() => { intent.request.query = 'changed' }, TypeError)
      assert(!JSON.stringify(intent).includes(key))
      assert(signal instanceof AbortSignal)
      assert.equal(signal.aborted, false)
      started()
      await gate
      order.push('durable')
    }
  })
  const pending = provider.search({ query })
  await ready
  assert.deepEqual(order, ['credentials', 'intent'])
  release()
  await pending
  assert.deepEqual(order, ['credentials', 'intent', 'durable', 'transport'])
  let fetchIntent
  await factory(async () => json({ title: '', content: '' }), { beforeRequest: intent => { fetchIntent = intent } }).fetch({ url })
  assert.deepEqual(fetchIntent, { provider: 'deepseek', operation: 'fetch', request: { url } })
})

test('preflight rejection is sanitized, and cancelled or timed-out late hooks cannot dispatch', async () => {
  let calls = 0
  const transport = async () => { calls++; return json({ title: '', content: '' }) }
  for (const beforeRequest of [() => { throw Error(key + url) }, async () => { throw new WebProviderError(key, 'http', url) }]) {
    await assert.rejects(factory(transport, { beforeRequest }).fetch({ url }), caught => sanitized(caught, 'preflight', 'not_started'))
  }
  let finish
  let hookSignal
  await assert.rejects(factory(transport, { timeoutMs: 10, beforeRequest: (_, signal) => {
    hookSignal = signal
    return new Promise(resolve => { finish = resolve })
  } }).fetch({ url }), caught => sanitized(caught, 'timeout', 'not_started'))
  assert.equal(hookSignal.aborted, true)
  finish()
  await new Promise(resolve => setImmediate(resolve))
  const controller = new AbortController()
  let abortFinish
  await assert.rejects(factory(transport, { beforeRequest: () => {
    controller.abort(Error('UPSTREAM_SECRET'))
    return new Promise(resolve => { abortFinish = resolve })
  } }).fetch({ url }, controller.signal), caught => sanitized(caught, 'aborted', 'not_started'))
  abortFinish()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 0)
})

test('body-read timeout and caller abort cancel reads after the provider response', async () => {
  let cancelled = 0
  const stalled = () => new Response(new ReadableStream({ pull() {}, cancel() { cancelled++ } }))
  await assert.rejects(factory(async () => stalled(), { timeoutMs: 10 }).fetch({ url }),
    caught => sanitized(caught, 'timeout', 'response_received'))
  const controller = new AbortController()
  const pending = factory(async () => {
    const response = stalled()
    setTimeout(() => controller.abort(Error('UPSTREAM_SECRET')), 5)
    return response
  }).fetch({ url }, controller.signal)
  await assert.rejects(pending, caught => sanitized(caught, 'aborted', 'response_received'))
  assert.equal(cancelled, 2)
})

test('late transport responses after timeout are cancelled and deadline includes synchronous work', async () => {
  let cancelled = false
  let deliver
  await assert.rejects(factory(async () => new Promise(resolve => { deliver = resolve }), { timeoutMs: 10 }).fetch({ url }),
    caught => sanitized(caught, 'timeout', 'unknown'))
  deliver(new Response(new ReadableStream({ pull() {}, cancel() { cancelled = true } })))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled, true)
  await assert.rejects(factory(() => {
    const deadline = performance.now() + 15
    while (performance.now() < deadline) {}
    return Promise.resolve(json({ title: '', content: '' }))
  }, { timeoutMs: 5 }).fetch({ url }), caught => sanitized(caught, 'timeout', 'unknown'))
})
