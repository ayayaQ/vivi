// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOpenAIProvider } from '../dist/providers/openai.js'
import { createOpenRouterProvider } from '../dist/providers/openrouter.js'
import { createDeepSeekProvider } from '../dist/providers/deepseek.js'

const key = 'fixture-private-key', secret = 'private-upstream-text'
const input = { messages: [{ kind: 'message', role: 'user', content: 'Hello' }], tools: [] }
const signal = () => new AbortController().signal
const frame = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
const message = text => ({ type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] })
const completed = text => ({ type: 'response.completed', response: { status: 'completed', output: [message(text)] } })
const factories = { OpenAI: createOpenAIProvider, OpenRouter: createOpenRouterProvider, DeepSeek: createDeepSeekProvider }
const terminal = (name, text = 'Hello 🐈') => name === 'OpenAI' ? frame(completed(text))
  : frame({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }) + frame('[DONE]')
function response(text, type, fragments = 7, extra = {}) {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text
  let offset = 0
  return new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return }
    controller.enqueue(bytes.slice(offset, offset += Math.min(fragments, bytes.length - offset)))
  } }), { headers: { ...(type === undefined ? {} : { 'content-type': type }), ...extra } })
}
function provider(reply, options = {}, factory = createOpenAIProvider) {
  return factory({ model: 'fixture', apiKey: key, stream: true, fetch: async () => reply, ...options })
}

for (const [name, factory] of Object.entries(factories)) {
  test(`${name} recognizes genuine fragmented SSE with missing or incorrect MIME, preserving terminal validation`, async () => {
    for (const type of [undefined, 'application/json', 'text/plain; charset=utf-8', 'text/html', 'text/event-stream-not-really']) {
      const text = '\ufeff: keepalive\r\nretry: 1000\r\nid: fixture\r\n\r\n' + terminal(name).replaceAll('\n', '\r\n')
      const turn = await provider(response(text, type, 1), {}, factory).generate(input, signal())
      assert.equal(turn.content, 'Hello 🐈'); assert.deepEqual(turn.toolCalls, [])
    }
  })
}

test('SSE negotiation is explicit and MIME parameters are not mistaken for protocol identity', async () => {
  for (const stream of [false, true]) {
    const p = createOpenAIProvider({ model: 'fixture', apiKey: key, stream, fetch: async (_url, init) => {
      assert.equal(new Headers(init.headers).get('accept'), stream ? 'text/event-stream' : 'application/json')
      return stream ? response(terminal('OpenAI'), 'Text/Event-Stream; charset=UTF-8')
        : new Response(JSON.stringify(completed('Done').response))
    } })
    await p.generate(input, signal())
  }
})

test('non-SSE JSON and HTML never become successful inference and retain safe opt-in metadata', async () => {
  for (const [body, type, shape] of [
    [JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', param: 'model', message: secret } }), 'application/json; private=secret', 'error'],
    [JSON.stringify({ detail: secret }), 'application/json', 'detail'],
    [JSON.stringify(completed('Not an SSE frame').response), 'application/json', 'other'],
    [`<html>${secret}</html>`, 'text/html', 'unreadable'],
    ['{invalid-json', undefined, 'unreadable']
  ]) {
    const p = provider(response(body, type, 65536, { 'x-request-id': 'req_mime_fixture' }), { errorDetails: true })
    await assert.rejects(p.generate(input, signal()), error => {
      assert.equal(error.code, 'invalid_response'); assert.equal(error.status, 200)
      assert.match(error.message, /not event-stream/); assert.equal(error.details.bodyShape, shape)
      assert.equal(error.details.requestId, 'req_mime_fixture')
      assert.equal(error.details.contentType, type?.split(';')[0])
      if (shape === 'error') { assert.equal(error.details.code, 'subscription_sharing_usage_limit_exceeded'); assert.equal(error.details.param, 'model') }
      assert(Object.isFrozen(error.details)); assert(!JSON.stringify(error).includes(secret)); assert(!JSON.stringify(error).includes(key)); return true
    })
  }
})

test('MIME mismatch diagnostics remain opt-in and omit unsafe header identifiers and parameters', async () => {
  for (const details of [false, true]) {
    for (const type of [`application/${key.toUpperCase()}`, 'invalid private media type', 'a/'.padEnd(130, 'b')]) {
      const p = provider(response(JSON.stringify({ error: { code: key, param: 'bad value' } }), type, 65536,
        { 'x-request-id': key }), { errorDetails: details })
      await assert.rejects(p.generate(input, signal()), error => {
        assert.equal(error.status, 200)
        assert.deepEqual(error.details, details ? { bodyShape: 'error' } : undefined)
        assert(!JSON.stringify(error).toLowerCase().includes(key)); return true
      })
    }
  }
})

test('non-SSE diagnostic JSON classification is independent of network fragmentation', async () => {
  const body = JSON.stringify({ error: { code: 'safe_code', param: 'model', message: secret } }, null, 2)
  for (const fragments of [1, 7, 65536]) {
    await assert.rejects(provider(response(body, 'application/json', fragments), { errorDetails: true }).generate(input, signal()), error => {
      assert.deepEqual(error.details, { bodyShape: 'error', code: 'safe_code', param: 'model', contentType: 'application/json' })
      assert(!JSON.stringify(error).includes(secret)); return true
    })
  }
})

test('MIME fallback rejects unframed prefixes even when a valid terminal frame follows', async () => {
  for (const prefix of ['<html>\n', '{"data":"private"}\n', 'unrecognized: text\n', ' data: {}\n']) {
    await assert.rejects(provider(response(prefix + terminal('OpenAI'), 'text/plain')).generate(input, signal()), /not event-stream/)
  }
})

test('MIME fallback cannot promote partial or malformed events to a completed response', async () => {
  for (const body of [frame({ type: 'response.output_text.delta', delta: 'partial' }), frame({ type: 'response.created' }),
    frame({ type: 'response.completed', response: { status: 'incomplete', output: [] } }),
    frame('{bad-json'), terminal('OpenAI').trimEnd()]) {
    await assert.rejects(provider(response(body, undefined)).generate(input, signal()), error => error.code === 'invalid_response')
  }
})

test('MIME fallback bounds recognition and diagnostic capture and cancels an open non-SSE body', async () => {
  let cancelled = 0, sent = false
  const reply = new Response(new ReadableStream({ pull(controller) {
    if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('x'.repeat(65537))) }
  }, cancel() { cancelled++ } }), { headers: { 'content-type': 'text/plain', 'x-request-id': 'req_bounded' } })
  await assert.rejects(provider(reply, { errorDetails: true, timeoutMs: 1000 }).generate(input, signal()), error => {
    assert.equal(error.code, 'invalid_response'); assert.equal(error.status, 200)
    assert.deepEqual(error.details, { bodyShape: 'unreadable', requestId: 'req_bounded', contentType: 'text/plain' }); return true
  })
  assert.equal(cancelled, 1)
})

test('MIME recognition does not reduce the existing event limit for a valid large first frame', async () => {
  const text = 'x'.repeat(70000)
  assert.equal((await provider(response(terminal('OpenAI', text), undefined, 4096)).generate(input, signal())).content, text)
})

test('MIME fallback rejects invalid UTF-8 without exposing bytes and preserves HTTP status', async () => {
  await assert.rejects(provider(response(new Uint8Array([0xc3, 0x28]), 'text/plain'), { errorDetails: true }).generate(input, signal()), error => {
    assert.equal(error.code, 'invalid_response'); assert.equal(error.status, 200); assert.equal(error.details.bodyShape, 'unreadable'); return true
  })
})

test('an empty successful response preserves HTTP status without becoming a completed stream', async () => {
  await assert.rejects(provider(new Response(null, { status: 204 }), { errorDetails: true }).generate(input, signal()), error => {
    assert.equal(error.status, 204); assert.equal(error.code, 'invalid_response'); assert.equal(error.details.bodyShape, 'unreadable'); return true
  })
})

test('MIME recognition remains abortable when a transport leaves a non-SSE response open', { timeout: 2000 }, async () => {
  let cancelled = 0
  const reply = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(': pending\n')) },
    cancel() { cancelled++ } }))
  const controller = new AbortController(), pending = provider(reply).generate(input, controller.signal)
  await new Promise(resolve => setTimeout(resolve, 0)); controller.abort()
  await assert.rejects(pending, error => error.code === 'aborted'); assert.equal(cancelled, 1)
})

test('rejected framing diagnostic collection stays abortable and within the original deadline', { timeout: 2000 }, async () => {
  for (const mode of ['abort', 'timeout']) {
    let cancelled = 0
    const reply = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{\n')) },
      cancel() { cancelled++ } }), { headers: { 'content-type': 'application/json' } })
    const controller = new AbortController()
    const pending = provider(reply, { errorDetails: true, timeoutMs: mode === 'timeout' ? 20 : 1000 }).generate(input, controller.signal)
    if (mode === 'abort') { await new Promise(resolve => setTimeout(resolve, 0)); controller.abort() }
    await assert.rejects(pending, error => error.code === (mode === 'abort' ? 'aborted' : 'timeout'))
    assert.equal(cancelled, 1)
  }
})

test('rejected framing diagnostic drain stops at its byte limit even when the body stays open', async () => {
  let cancelled = 0, index = 0
  const reply = new Response(new ReadableStream({ pull(controller) {
    if (index++ === 0) controller.enqueue(new TextEncoder().encode('{\n'))
    else controller.enqueue(new Uint8Array(65536))
  }, cancel() { cancelled++ } }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } })
  await assert.rejects(provider(reply, { errorDetails: true, timeoutMs: 1000 }).generate(input, signal()), error => {
    assert.equal(error.code, 'invalid_response'); assert.equal(error.details.bodyShape, 'unreadable'); return true
  })
  assert.equal(cancelled, 1); assert.equal(index, 2)
})

test('non-SSE diagnostics retain exactly the 64KiB boundary but never parse an oversized body', async () => {
  const base = { error: { code: 'safe_code', padding: '' } }
  const fixed = new TextEncoder().encode(JSON.stringify(base)).byteLength
  for (const size of [65536, 65537]) {
    const body = JSON.stringify({ error: { ...base.error, padding: 'x'.repeat(size - fixed) } })
    assert.equal(new TextEncoder().encode(body).byteLength, size)
    await assert.rejects(provider(response(body, 'application/json', 7), { errorDetails: true }).generate(input, signal()), error => {
      assert.equal(error.details.bodyShape, size === 65536 ? 'error' : 'unreadable')
      assert.equal(error.details.code, size === 65536 ? 'safe_code' : undefined); return true
    })
  }
})

test('events after rejected framing never become progress or completed inference during diagnostic collection', async () => {
  let progress = 0
  const body = '{\n' + frame({ type: 'response.output_text.delta', delta: 'must not display' }) + terminal('OpenAI')
  await assert.rejects(provider(response(body, 'application/json', 1), { errorDetails: true }).generate(input, signal(),
    { onProgress() { progress++ } }), /not event-stream/)
  assert.equal(progress, 0)
})
