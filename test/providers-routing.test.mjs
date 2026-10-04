// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test as nodeTest } from 'node:test'
import { createOpenAIProvider } from '../dist/providers/openai.js'
import { createOpenRouterProvider } from '../dist/providers/openrouter.js'

const test = (name, fn) => nodeTest(name, { timeout: 3_000 }, fn)
const input = { messages: [{ kind: 'message', role: 'user', content: 'Offline fixture' }], tools: [
  { name: 'fixture', description: 'Offline fixture', parameters: { type: 'object' } }
] }
const signal = () => new AbortController().signal
const reply = { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Done' } }] }
const response = (stream) => stream
  ? new Response('data: {"choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' }
  })
  : new Response(JSON.stringify(reply))

test('OpenRouter routing is opt-in and independent of tools, reasoning and streaming', async () => {
  for (const stream of [false, true]) {
    for (const requireSupportedParameters of [undefined, false, true]) {
      for (const tools of [[], input.tools]) {
        for (const reasoning of [{ mode: 'default' }, { mode: 'disabled' }, { mode: 'effort', effort: 'high' }]) {
          let body
          const provider = createOpenRouterProvider({
            model: 'fixture/router', apiKey: 'offline-fixture-key', stream, requireSupportedParameters,
            reasoning, supportedReasoningEfforts: ['none', 'high'],
            fetch: async (_url, init) => { body = JSON.parse(init.body); return response(stream) }
          })
          assert.equal((await provider.generate({ ...input, tools }, signal())).content, 'Done')
          assert.equal(body.stream, stream)
          if (stream) assert.deepEqual(body.stream_options, { include_usage: true })
          if (requireSupportedParameters) assert.deepEqual(body.provider, { require_parameters: true })
          else assert.equal(Object.hasOwn(body, 'provider'), false)
          assert.equal(Object.hasOwn(body, 'tool_choice'), false)
          if (tools.length) assert.deepEqual(body.tools, [{ type: 'function', function: input.tools[0] }])
          else assert.equal(Object.hasOwn(body, 'tools'), false)
          if (reasoning.mode === 'default') assert.equal(Object.hasOwn(body, 'reasoning'), false)
          else assert.deepEqual(body.reasoning,
            reasoning.mode === 'disabled' ? { enabled: false } : { effort: 'high', exclude: false })
        }
      }
    }
  }
})

test('OpenRouter validates routing options before credential resolution or HTTP', () => {
  let keys = 0
  let requests = 0
  for (const requireSupportedParameters of [null, 0, 1, 'private-value', [], {}, () => true]) {
    assert.throws(() => createOpenRouterProvider({
      model: 'fixture/router', requireSupportedParameters,
      apiKey: () => { keys++; return 'offline-fixture-key' },
      fetch: async () => { requests++; return response(false) }
    }), (error) => {
      assert.equal(error.name, 'ProviderRequestError')
      assert.equal(error.code, 'configuration')
      assert.match(error.message, /requireSupportedParameters.*boolean/)
      assert.equal(error.message.includes('private-value'), false)
      return true
    })
  }
  assert.equal(keys, 0)
  assert.equal(requests, 0)
})

test('OpenRouter captures the routing option at factory creation', async () => {
  for (const initial of [false, true]) {
    let body
    const options = {
      model: 'fixture/router', apiKey: 'offline-fixture-key', requireSupportedParameters: initial,
      fetch: async (_url, init) => { body = JSON.parse(init.body); return response(false) }
    }
    const provider = createOpenRouterProvider(options)
    options.requireSupportedParameters = !initial
    await provider.generate(input, signal())
    assert.equal(Object.hasOwn(body, 'provider'), initial)
  }
})

test('OpenRouter endpoint availability failures stay sanitized and do not retry', async () => {
  let requests = 0
  const provider = createOpenRouterProvider({
    model: 'fixture/router', apiKey: 'offline-fixture-key', requireSupportedParameters: true,
    fetch: async (_url, init) => {
      requests++
      assert.deepEqual(JSON.parse(init.body).provider, { require_parameters: true })
      return new Response('private provider details: no matching endpoint', { status: 404 })
    }
  })
  await assert.rejects(provider.generate(input, signal()), (error) => {
    assert.equal(error.code, 'http')
    assert.equal(error.status, 404)
    assert.equal(error.message.includes('private provider details'), false)
    assert.equal(error.message.includes('offline-fixture-key'), false)
    return true
  })
  assert.equal(requests, 1)
})

test('OpenRouter strict routing preserves cancellation for an abort-ignoring transport', async () => {
  const controller = new AbortController()
  let begin
  const started = new Promise((resolve) => { begin = resolve })
  let finish
  const provider = createOpenRouterProvider({
    model: 'fixture/router', apiKey: 'offline-fixture-key', requireSupportedParameters: true,
    fetch: async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body).provider, { require_parameters: true })
      begin(init.signal)
      return new Promise((resolve) => { finish = resolve })
    }
  })
  const run = provider.generate(input, controller.signal)
  const transportSignal = await started
  controller.abort()
  await assert.rejects(run, (error) => error.name === 'AbortError' && error.code === 'aborted')
  assert.equal(transportSignal.aborted, true)
  finish(response(false))
})

test('OpenRouter strict routing preserves finite transport deadlines', async () => {
  let requests = 0
  const provider = createOpenRouterProvider({
    model: 'fixture/router', apiKey: 'offline-fixture-key', requireSupportedParameters: true, timeoutMs: 20,
    fetch: async (_url, init) => {
      requests++
      assert.deepEqual(JSON.parse(init.body).provider, { require_parameters: true })
      return new Promise(() => {})
    }
  })
  await assert.rejects(provider.generate(input, signal()), (error) => error.code === 'timeout')
  assert.equal(requests, 1)
})

test('OpenAI streaming omits tool fields when the host disables tools', async () => {
  let body
  const provider = createOpenAIProvider({
    model: 'fixture-openai', apiKey: 'offline-fixture-key', stream: true,
    fetch: async (_url, init) => {
      body = JSON.parse(init.body)
      return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n', {
        headers: { 'content-type': 'text/event-stream' }
      })
    }
  })
  await provider.generate({ ...input, tools: [] }, signal())
  assert.equal(body.stream, true)
  assert.equal(Object.hasOwn(body, 'tools'), false)
  assert.equal(Object.hasOwn(body, 'tool_choice'), false)
  assert.equal(Object.hasOwn(body, 'provider'), false)
})
