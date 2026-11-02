// SPDX-License-Identifier: Apache-2.0
'use strict'
// Offline installed-package contracts. Every provider has an injected synthetic transport.
const assert = require('node:assert/strict')
const { test } = require('node:test')

module.exports = function register({ createOpenAIProvider, ProviderRequestError }, mode) {
  const testCase = (name, body) => test(`${mode}: ${name}`, { timeout: 3000 }, body)
  const key = 'offline-private-bearer-value'
  const privateDetail = 'offline-private-upstream-detail'
  const signal = () => new AbortController().signal
  const seed = () => ({ messages: [
    { kind: 'message', role: 'system', content: 'Host instructions' },
    { kind: 'message', role: 'user', content: 'Inspect state' }
  ], tools: [{ name: 'read_state', description: 'Read state', parameters: {
    type: 'object', properties: { target: { type: 'string', description: 'Original schema' } }
  } }] })
  const frame = value => `data: ${JSON.stringify(value)}\n\n`
  const completed = { type: 'response.completed', response: { status: 'completed', output: [] } }
  const streamResponse = (...events) => new Response(events.map(frame).join(''), {
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_offline_1' }
  })
  const jsonResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json', ...headers }
  })
  function harness(replies, options = {}) {
    const requests = []
    const configured = { model: 'fixture-model', apiKey: key,
      fetch: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers) })
        assert(replies.length, 'Unexpected synthetic request; no live transport fallback exists')
        return replies.shift()
      }, ...options }
    const provider = createOpenAIProvider(configured)
    return { provider, requests, configured }
  }
  function expectedEstimate(body) {
    const prompt = Object.fromEntries(['input', 'messages', 'tools', 'tool_choice', 'reasoning']
      .filter(name => body[name] !== undefined).map(name => [name, body[name]]))
    const text = JSON.stringify(prompt)
    let ascii = 0
    for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) < 128) ascii++
    const bytes = new TextEncoder().encode(text).byteLength
    return { inputTokens: Math.ceil(ascii / 3 + (bytes - ascii) / 2) + 32 +
      (body.input ?? body.messages).length * 8 + (body.tools?.length ?? 0) * 16, estimated: true }
  }
  function compatible(body) {
    const result = { ...body, input: body.input.map(item => item.role === 'system' ? { ...item, role: 'developer' } : item) }
    delete result.max_output_tokens
    if (result.tools?.length) result.tools = [{ type: 'namespace', name: 'fixture', description: 'Offline fixture tools', tools: result.tools }]
    return result
  }

  testCase('projection has exact estimate/wire parity without resolving credentials during estimation', async () => {
    const projected = []; let credentials = 0
    const options = { stream: true, apiKey: async () => { credentials++; return key },
      transformRequest(body) { const result = compatible(body); projected.push(structuredClone(result)); return result } }
    const h = harness([streamResponse(completed)], options)
    h.configured.transformRequest = () => { throw Error('Mutable options must not replace captured callback') }
    const input = seed(), before = structuredClone(input)
    const estimate = h.provider.estimateContext(input, { maxOutputTokens: 37 })
    assert.equal(credentials, 0); assert.equal(h.requests.length, 0)
    await h.provider.generate(input, signal(), { maxOutputTokens: 37, purpose: 'context-summary' })
    assert.equal(credentials, 1)
    assert.deepEqual(estimate, expectedEstimate(h.requests[0].body))
    assert.deepEqual(projected[0], h.requests[0].body); assert.deepEqual(projected[1], h.requests[0].body)
    assert.equal(h.requests[0].body.input[0].role, 'developer')
    assert.equal(h.requests[0].body.tools[0].type, 'namespace')
    assert.equal('max_output_tokens' in h.requests[0].body, false)
    assert.equal('purpose' in h.requests[0].body, false)
    assert.deepEqual(input, before)
  })

  // Preserve the release regression: callback input must not alias canonical nested data.
  testCase('projection body is detached from canonical tool schemas and fixed reasoning configuration', async () => {
    const input = seed(), before = structuredClone(input), initialEfforts = []
    const h = harness([streamResponse(completed)], { stream: true,
      reasoning: { mode: 'effort', effort: 'high' }, supportedReasoningEfforts: ['high', 'low'],
      transformRequest(body) {
        initialEfforts.push(body.reasoning.effort)
        body.tools[0].parameters.properties.target.description = 'Projection-local schema'
        body.reasoning.effort = 'low'
        return body
      } })
    h.provider.estimateContext(input)
    assert.deepEqual(input, before, 'Estimation projection must not mutate canonical caller tool schemas')
    await h.provider.generate(input, signal())
    assert.deepEqual(input, before, 'Generation projection must not mutate canonical caller tool schemas')
    assert.deepEqual(initialEfforts, ['high', 'high'], 'A projection must not mutate the adapter configuration for later calls')
    assert.equal(h.requests[0].body.tools[0].parameters.properties.target.description, 'Projection-local schema')
  })

  testCase('unsupported projections reject before HTTP without leaking their thrown details', async () => {
    for (const transformRequest of [
      body => ({ ...body, model: 'other-model' }), body => ({ ...body, stream: false }),
      body => ({ ...body, unsupported: undefined }), () => null,
      () => { throw Error(privateDetail) }
    ]) {
      const h = harness([], { stream: true, transformRequest })
      assert.throws(() => h.provider.estimateContext(seed()), error => /projection/.test(error.message) && !error.message.includes(privateDetail))
      await assert.rejects(h.provider.generate(seed(), signal()), error => error instanceof ProviderRequestError &&
        /projection/.test(error.message) && !error.message.includes(privateDetail))
      assert.equal(h.requests.length, 0)
    }
  })

  testCase('default API-key request encoding remains flat, nonstreaming and output-bounded', async () => {
    const h = harness([jsonResponse({ status: 'completed', output: [] })])
    const input = seed()
    await h.provider.generate(input, signal(), { maxOutputTokens: 71 })
    const request = h.requests[0]
    assert.equal(request.url, 'https://api.openai.com/v1/responses')
    assert.equal(request.headers.get('authorization'), `Bearer ${key}`)
    assert.equal(request.body.input[0].role, 'system')
    assert.deepEqual(request.body.tools, input.tools.map(tool => ({ type: 'function', ...tool, strict: false })))
    assert.equal(request.body.stream, false); assert.equal(request.body.store, false)
    assert.equal(request.body.max_output_tokens, 71)
    assert.deepEqual(request.body.include, ['reasoning.encrypted_content'])
    assert.equal('reasoning' in request.body, false)
  })

  testCase('HTTP and terminal SSE errors retain opt-in status/code/param/requestId, not raw secrets', async () => {
    const errorBody = { error: { code: 'subscription_sharing_usage_limit_exceeded', param: 'input[0]', message: privateDetail, echoed: key } }
    for (const [response, status] of [
      [jsonResponse(errorBody, 429, { 'x-request-id': 'req_offline_1' }), 429],
      [streamResponse({ type: 'response.failed', response: errorBody }), 200]
    ]) {
      const h = harness([response], { stream: true, errorDetails: true })
      await assert.rejects(h.provider.generate(seed(), signal()), error => {
        assert(error instanceof ProviderRequestError)
        assert.equal(error.status, status)
        assert.deepEqual(error.details, { code: 'subscription_sharing_usage_limit_exceeded', param: 'input[0]', requestId: 'req_offline_1', bodyShape: 'error' })
        assert(Object.isFrozen(error.details)); assert.equal(error.cause, undefined)
        assert(!JSON.stringify(error).includes(privateDetail)); assert(!JSON.stringify(error).includes(key))
        assert(!error.message.includes(privateDetail)); assert(!error.message.includes(key))
        return true
      })
      assert.equal(h.requests.length, 1)
    }
  })

  testCase('diagnostics are opt-in and preserve detail/unreadable/other body shape without raw values', async () => {
    for (const [body, bodyShape] of [
      [JSON.stringify({ detail: privateDetail }), 'detail'], ['not valid JSON', 'unreadable'],
      [JSON.stringify({ other: privateDetail }), 'other']
    ]) {
      const h = harness([new Response(body, { status: 503 })], { errorDetails: true })
      await assert.rejects(h.provider.generate(seed(), signal()), error => {
        assert.equal(error.status, 503); assert.deepEqual(error.details, { bodyShape })
        assert(!JSON.stringify(error).includes(privateDetail)); return true
      })
    }
    const h = harness([jsonResponse({ error: { code: 'safe_code', message: privateDetail } }, 400)])
    await assert.rejects(h.provider.generate(seed(), signal()), error => error.status === 400 && error.details === undefined)
  })

  testCase('bearer-bearing, nonidentifier and oversized diagnostic fields are safely omitted', async () => {
    for (const invalid of [key, 'unsafe/value', 'unsafe value', 'x'.repeat(201)]) {
      const h = harness([jsonResponse({ error: { code: invalid, param: invalid, message: privateDetail } }, 400,
        { 'x-request-id': invalid })], { errorDetails: true })
      await assert.rejects(h.provider.generate(seed(), signal()), error => {
        assert.deepEqual(error.details, { bodyShape: 'error' })
        assert(!JSON.stringify(error).includes(key)); assert(!JSON.stringify(error).includes(privateDetail)); return true
      })
    }
  })

  testCase('throwing and rejected projections isolate mutations and allow later successful calls', async () => {
    for (const rejection of ['throw', 'identity', 'non-JSON']) {
      const input = seed(), before = structuredClone(input), initialEfforts = []
      let reject = true
      const h = harness([streamResponse(completed)], { stream: true,
        reasoning: { mode: 'effort', effort: 'high' }, supportedReasoningEfforts: ['high', 'low'],
        transformRequest(body) {
          initialEfforts.push(body.reasoning.effort)
          assert.equal(body.tools[0].parameters.properties.target.description, 'Original schema')
          assert.equal(body.input[0].content, 'Host instructions')
          assert(!JSON.stringify(body).includes(key), 'Projection must never receive credentials')
          body.tools[0].parameters.properties.target.description = 'Projection-local schema'
          body.input[0].content = 'Projection-local instructions'
          body.reasoning.effort = 'low'
          if (!reject) return body
          if (rejection === 'throw') throw Error(privateDetail)
          if (rejection === 'identity') return { ...body, model: 'other-model' }
          return { ...body, unsupported: undefined }
        } })
      const reasoningBefore = structuredClone(h.configured.reasoning)
      const sanitized = error => {
        assert(error instanceof ProviderRequestError)
        assert.match(error.message, /projection/)
        assert.equal(error.cause, undefined)
        assert(!JSON.stringify(error).includes(privateDetail))
        assert(!error.message.includes(privateDetail))
        assert(!error.message.includes(key))
        return true
      }
      assert.throws(() => h.provider.estimateContext(input), sanitized)
      assert.deepEqual(input, before)
      await assert.rejects(h.provider.generate(input, signal()), sanitized)
      assert.deepEqual(input, before)
      assert.deepEqual(h.configured.reasoning, reasoningBefore)
      assert.equal(h.requests.length, 0)
      reject = false
      const estimate = h.provider.estimateContext(input)
      const result = await h.provider.generate(input, signal())
      assert.equal(result.content, '')
      assert.deepEqual(result.toolCalls, [])
      assert.deepEqual(estimate, expectedEstimate(h.requests[0].body))
      assert.equal(h.requests.length, 1)
      assert.deepEqual(input, before)
      assert.deepEqual(h.configured.reasoning, reasoningBefore)
      assert.deepEqual(initialEfforts, ['high', 'high', 'high', 'high'])
      assert.equal(h.requests[0].body.reasoning.effort, 'low')
      assert.equal(h.requests[0].body.input[0].content, 'Projection-local instructions')
    }
  })

  testCase('asynchronous and cyclic projection results reject before transport', async () => {
    for (const transformRequest of [
      async body => body,
      body => { body.cycle = body; return body }
    ]) {
      const h = harness([], { transformRequest })
      const input = seed(), before = structuredClone(input)
      assert.throws(() => h.provider.estimateContext(input), /projection/)
      await assert.rejects(h.provider.generate(input, signal()), error =>
        error instanceof ProviderRequestError && /projection/.test(error.message))
      assert.deepEqual(input, before)
      assert.equal(h.requests.length, 0)
    }
  })

  testCase('diagnostic identifiers accept the 200-character boundary and omit unsafe fields independently', async () => {
    const boundary = 'a'.repeat(200)
    for (const response of [
      jsonResponse({ error: { code: boundary, param: boundary } }, 400, { 'x-request-id': boundary }),
      streamResponse({ type: 'response.failed', response: { error: { code: boundary, param: boundary } } })
    ]) {
      const h = harness([response], { stream: true, errorDetails: true })
      await assert.rejects(h.provider.generate(seed(), signal()), error => {
        assert.deepEqual(error.details, { bodyShape: 'error', code: boundary, param: boundary,
          requestId: response.headers.get('x-request-id') })
        assert(Object.isFrozen(error.details))
        return true
      })
    }
    for (const invalid of ['', 17, null, { code: 'nested' }, ['array'], 'bad\nparam', `prefix.${key}.suffix`, 'b'.repeat(201)]) {
      const h = harness([jsonResponse({ error: { code: 'safe_code', param: invalid, message: privateDetail } },
        400, { 'x-request-id': 'req_safe' })], { errorDetails: true })
      await assert.rejects(h.provider.generate(seed(), signal()), error => {
        assert.deepEqual(error.details, { bodyShape: 'error', code: 'safe_code', requestId: 'req_safe' })
        assert(!JSON.stringify(error).includes(key))
        assert(!JSON.stringify(error).includes(privateDetail))
        return true
      })
    }
  })

  testCase('oversized HTTP diagnostic bodies are canceled and retain only safe bounded metadata', async () => {
    let canceled = 0
    const oversized = new TextEncoder().encode(JSON.stringify({ error: {
      code: 'safe_code', message: privateDetail, padding: 'x'.repeat(65_536)
    } }))
    const body = new ReadableStream({
      start(controller) { controller.enqueue(oversized) },
      cancel() { canceled++ }
    })
    const h = harness([new Response(body, { status: 503, headers: { 'x-request-id': 'req_bounded' } })],
      { errorDetails: true })
    await assert.rejects(h.provider.generate(seed(), signal()), error => {
      assert(error instanceof ProviderRequestError)
      assert.equal(error.status, 503)
      assert.deepEqual(error.details, { bodyShape: 'unreadable', requestId: 'req_bounded' })
      assert.equal(error.cause, undefined)
      assert(!JSON.stringify(error).includes(privateDetail))
      assert(!JSON.stringify(error).includes(key))
      return true
    })
    assert.equal(canceled, 1)
    assert.equal(h.requests.length, 1)
  })
}
