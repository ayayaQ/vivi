// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { test as nodeTest } from 'node:test'
import { createOpenAIProvider } from '../dist/providers/openai.js'
import { createOpenRouterProvider } from '../dist/providers/openrouter.js'
import { runAgent } from '../dist/index.js'

const test = (name, fn) => nodeTest(name, { timeout: 3_000 }, fn)
const timeoutMs = 60_000
const encoder = new TextEncoder()
const input = {
  messages: [{ kind: 'message', role: 'user', content: 'Use the offline fixture' }],
  tools: [{ name: 'fixture', description: 'Offline fixture', parameters: { type: 'object' } }]
}
const signal = () => new AbortController().signal
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const frame = (value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
const argumentsJson = '{"value":1}'
const call = { id: 'call_1', name: 'fixture', arguments: { value: 1 } }
const output = (kind) => kind === 'OpenAI' ? {
  status: 'completed', output: [{
    type: 'function_call', id: 'fc_1', call_id: call.id, name: call.name,
    arguments: argumentsJson, status: 'completed'
  }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 }
} : {
  choices: [{ message: {
    role: 'assistant', content: '', tool_calls: [{
      id: call.id, type: 'function', function: { name: call.name, arguments: argumentsJson }
    }]
  }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
}
const delta = (kind, text) => kind === 'OpenAI'
  ? { type: 'response.output_text.delta', delta: text }
  : { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }
const terminal = (kind) => kind === 'OpenAI'
  ? frame({ type: 'response.completed', response: output(kind) })
  : frame({ choices: [{ index: 0, delta: {
    ...output(kind).choices[0].message,
    tool_calls: output(kind).choices[0].message.tool_calls.map((call, index) => ({ index, ...call }))
  }, finish_reason: 'tool_calls' }],
    usage: output(kind).usage }) + frame('[DONE]')
const response = (kind, stream, prefix = '') => new Response(
  stream ? prefix + terminal(kind) : JSON.stringify(output(kind)),
  { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } }
)

// Advance a monotonic clock inside synchronous work, without running the deadline timer.
// No real waits or busy loops are needed, and every provider uses injected offline HTTP.
function clock(t) {
  let now = 1_000_000
  t.mock.method(performance, 'now', () => now)
  return { advance(ms = timeoutMs) { now += ms } }
}
function provider(kind, fetch, options = {}) {
  const factory = kind === 'OpenAI' ? createOpenAIProvider : createOpenRouterProvider
  return factory({ model: `fixture-${kind}`, apiKey: 'offline-key', timeoutMs, fetch, ...options })
}
function timedOut(kind) {
  return (error) => {
    assert.equal(error.name, 'ProviderRequestError')
    assert.equal(error.code, 'timeout')
    assert.equal(error.provider, kind)
    assert.equal(error.message, `${kind} request timed out`)
    assert.equal(error.cause, undefined)
    return true
  }
}
function cancelled(kind) {
  return (error) => {
    assert.equal(error.name, 'AbortError')
    assert.equal(error.code, 'aborted')
    assert.equal(error.message, `${kind} request cancelled`)
    return true
  }
}
async function noAcceptedTools(adapter, options = {}) {
  let executions = 0
  const events = []
  const result = await runAgent({
    ...input, provider: adapter,
    ...(options.signal ? { signal: options.signal } : {}),
    executeTool: async () => { executions++; return { content: 'must never execute' } },
    onEvent(event) { events.push(event); return options.onEvent?.(event) }
  })
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, options.errorCode ?? 'provider_error')
  assert.equal(executions, 0)
  assert.equal(result.rounds, 0)
  assert.equal(result.content, '')
  assert.deepEqual(result.history, input.messages)
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  assert.ok(events.every((event) => event.type === 'text_delta'))
  return { result, events }
}

for (const kind of ['OpenAI', 'OpenRouter']) {
  test(`${kind} synchronous credential resolution cannot issue HTTP at or past the deadline`, async (t) => {
    const time = clock(t)
    let requests = 0
    for (const overrun of [timeoutMs, timeoutMs + 1]) {
      for (const throws of [false, true]) {
        const adapter = provider(kind, async () => { requests++; return response(kind, false) }, {
          apiKey() {
            time.advance(overrun)
            if (throws) throw new Error('private credential failure')
            return 'offline-key'
          }
        })
        await assert.rejects(adapter.generate(input, signal()), timedOut(kind))
      }
    }
    assert.equal(requests, 0)
  })

  test(`${kind} synchronous history projection cannot issue a late HTTP request`, async (t) => {
    const time = clock(t)
    let requests = 0
    const adapter = provider(kind, async () => { requests++; return response(kind, false) })
    const messages = [{ kind: 'message', role: 'user', get content() {
      time.advance()
      return 'Projection finished too late'
    } }]
    await assert.rejects(adapter.generate({ ...input, messages }, signal()), timedOut(kind))
    assert.equal(requests, 0)
  })

  test(`${kind} checks serialization before HTTP issuance even when serialization fails`, async (t) => {
    const time = clock(t)
    let requests = 0
    const adapter = provider(kind, async () => { requests++; return response(kind, false) })
    for (const throws of [false, true]) {
      const tools = [{ ...input.tools[0], parameters: { toJSON() {
        time.advance()
        if (throws) throw new Error('private serialization failure')
        return { type: 'object' }
      } } }]
      await assert.rejects(adapter.generate({ ...input, tools }, signal()), timedOut(kind))
    }
    assert.equal(requests, 0)
  })

  for (const stream of [false, true]) {
    test(`${kind} ${stream ? 'streaming' : 'JSON'} late synchronous HTTP output is cancelled without tool dispatch`, async (t) => {
      const time = clock(t)
      let requests = 0
      let bodyCancelled = false
      let transportSignal
      const adapter = provider(kind, async (_url, init) => {
        requests++
        transportSignal = init.signal
        const bytes = encoder.encode(stream ? terminal(kind) : JSON.stringify(output(kind)))
        const body = new ReadableStream({
          start(controller) { controller.enqueue(bytes) },
          cancel() { bodyCancelled = true }
        })
        const late = new Response(body, { headers: {
          'content-type': stream ? 'text/event-stream' : 'application/json'
        } })
        time.advance()
        return late
      }, { stream })
      const { result } = await noAcceptedTools(adapter)
      assert.equal(result.error.message, `${kind} request timed out`)
      assert.equal(requests, 1)
      assert.equal(transportSignal.aborted, true)
      assert.equal(bodyCancelled, true)
    })

    test(`${kind} ${stream ? 'streaming' : 'JSON'} synchronous body reads cannot accept overdue tools`, async (t) => {
      const time = clock(t)
      let reads = 0
      const adapter = provider(kind, async () => new Response(new ReadableStream({
        pull(controller) {
          reads++
          time.advance()
          controller.enqueue(encoder.encode(stream ? terminal(kind) : JSON.stringify(output(kind))))
          controller.close()
        }
      }, { highWaterMark: 0 }), { headers: {
        'content-type': stream ? 'text/event-stream' : 'application/json'
      } }), { stream })
      const { result } = await noAcceptedTools(adapter)
      assert.equal(result.error.message, `${kind} request timed out`)
      assert.equal(reads, 1)
    })

    test(`${kind} ${stream ? 'streaming' : 'JSON'} buffered parsing and output normalization cannot accept overdue tools`, async (t) => {
      const time = clock(t)
      const parse = JSON.parse
      let phase
      let blocked = 0
      t.mock.method(JSON, 'parse', function (text, ...args) {
        const parsed = Reflect.apply(parse, this, [text, ...args])
        if ((phase === 'body' && text !== argumentsJson) || (phase === 'arguments' && text === argumentsJson)) {
          blocked++
          time.advance()
        }
        return parsed
      })
      for (phase of ['body', 'arguments']) {
        const adapter = provider(kind, async () => response(kind, stream), { stream })
        const { result } = await noAcceptedTools(adapter)
        assert.equal(result.error.message, `${kind} request timed out`)
      }
      assert.equal(blocked, 2)
    })
  }

  test(`${kind} parsing a buffered late text delta suppresses progress and following tool frames`, async (t) => {
    const time = clock(t)
    const parse = JSON.parse
    const first = JSON.stringify(delta(kind, 'must not display'))
    t.mock.method(JSON, 'parse', function (text, ...args) {
      const parsed = Reflect.apply(parse, this, [text, ...args])
      if (text === first) time.advance()
      return parsed
    })
    const adapter = provider(kind, async () => response(kind, true, `data: ${first}\n\n`), { stream: true })
    const { result, events } = await noAcceptedTools(adapter)
    assert.equal(result.error.message, `${kind} request timed out`)
    assert.deepEqual(events, [])
  })

  test(`${kind} synchronous progress overrun suppresses buffered later deltas and tool dispatch`, async (t) => {
    const time = clock(t)
    const prefix = frame(delta(kind, 'first')) + frame(delta(kind, 'late'))
    const adapter = provider(kind, async () => response(kind, true, prefix), { stream: true })
    const seen = []
    await assert.rejects(adapter.generate(input, signal(), { onProgress({ text }) {
      seen.push(text)
      time.advance()
    } }), timedOut(kind))
    assert.deepEqual(seen, ['first'])
    const { result, events } = await noAcceptedTools(adapter, { onEvent() { time.advance() } })
    assert.equal(result.error.message, `${kind} request timed out`)
    assert.deepEqual(events, [{ type: 'text_delta', text: 'first' }])
  })

  test(`${kind} preserves synchronous progress callback failures even after an overrun`, async (t) => {
    const time = clock(t)
    const failure = new Error('host progress failure')
    const adapter = provider(kind, async () => response(kind, true, frame(delta(kind, 'first'))), { stream: true })
    await assert.rejects(adapter.generate(input, signal(), { onProgress() {
      time.advance()
      throw failure
    } }), (error) => error === failure)
    const { result, events } = await noAcceptedTools(adapter, { errorCode: 'event_error', onEvent() {
      time.advance()
      throw failure
    } })
    assert.equal(result.error.message, failure.message)
    assert.deepEqual(events, [{ type: 'text_delta', text: 'first' }])
  })

  test(`${kind} timer expiry releases a never-settling core progress wait without accepting buffered tools`, async (t) => {
    const time = clock(t)
    const entered = deferred()
    const controller = new AbortController()
    const schedule = globalThis.setTimeout
    let expire, roundSignal
    t.mock.method(globalThis, 'setTimeout', function (callback, delay, ...args) {
      if (delay === timeoutMs) expire = () => callback(...args)
      return Reflect.apply(schedule, this, [callback, delay, ...args])
    })
    const base = provider(kind, async () => response(kind, true,
      frame(delta(kind, 'first')) + frame(delta(kind, 'buffered'))), { stream: true })
    const adapter = { generate(input, signal, progress) {
      roundSignal = signal
      return base.generate(input, signal, progress)
    } }
    const pending = noAcceptedTools(adapter, { signal: controller.signal, onEvent() {
      entered.resolve()
      return new Promise(() => {})
    } })
    await entered.promise
    assert.equal(typeof expire, 'function')
    time.advance()
    expire()
    const { result, events } = await pending
    assert.equal(result.error.message, `${kind} request timed out`)
    assert.deepEqual(events, [{ type: 'text_delta', text: 'first' }])
    assert.equal(roundSignal.aborted, true)
    assert.equal(controller.signal.aborted, false)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    assert.equal(getEventListeners(roundSignal, 'abort').length, 0)
  })

  test(`${kind} caller cancellation keeps AbortError classification at or past the deadline`, async (t) => {
    const time = clock(t)
    for (const phase of ['credentials', 'http', 'progress']) {
      const controller = new AbortController()
      let requests = 0
      const abort = () => { time.advance(timeoutMs + 1); controller.abort('private caller reason') }
      const adapter = provider(kind, async () => {
        requests++
        if (phase === 'http') abort()
        return response(kind, true, frame(delta(kind, 'first')))
      }, { stream: true, apiKey() {
        if (phase === 'credentials') abort()
        return 'offline-key'
      } })
      await assert.rejects(adapter.generate(input, controller.signal, { onProgress() {
        if (phase === 'progress') abort()
      } }), cancelled(kind))
      assert.equal(requests, phase === 'credentials' ? 0 : 1)
    }
  })

  test(`${kind} late synchronous HTTP and malformed JSON failures use the elapsed deadline`, async (t) => {
    const time = clock(t)
    const failedHttp = provider(kind, async () => { time.advance(); throw new Error('private HTTP failure') })
    await assert.rejects(failedHttp.generate(input, signal()), timedOut(kind))
    const parse = JSON.parse
    t.mock.method(JSON, 'parse', function (text, ...args) {
      if (text === '{broken-private-response') time.advance()
      return Reflect.apply(parse, this, [text, ...args])
    })
    const malformed = provider(kind, async () => new Response('{broken-private-response'))
    await assert.rejects(malformed.generate(input, signal()), timedOut(kind))
  })

  test(`${kind} in-deadline synchronous work accepts tools and retains ordinary error semantics`, async (t) => {
    const time = clock(t)
    for (const stream of [false, true]) {
      let requests = 0
      const tools = [{ ...input.tools[0], parameters: { toJSON() {
        time.advance(10_000)
        return { type: 'object' }
      } } }]
      const adapter = provider(kind, async () => {
        requests++
        time.advance(10_000)
        return response(kind, stream, frame(delta(kind, 'first')))
      }, { stream, apiKey() { time.advance(10_000); return 'offline-key' } })
      const seen = []
      const result = await adapter.generate({ ...input, tools }, signal(), { onProgress({ text }) {
        time.advance(10_000)
        seen.push(text)
      } })
      assert.deepEqual(result.toolCalls, [call])
      assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 3, totalTokens: 5 })
      assert.equal(requests, 1)
      assert.deepEqual(seen, stream ? ['first'] : [])
    }
    for (const [code, options, fetch] of [
      ['configuration', { apiKey() { throw new Error('private credential failure') } }, async () => { assert.fail('No HTTP') }],
      ['transport', {}, async () => { throw new Error('private HTTP failure') }],
      ['invalid_response', {}, async () => new Response('{broken-private-response')]
    ]) {
      const adapter = provider(kind, fetch, options)
      await assert.rejects(adapter.generate(input, signal()), (error) => {
        assert.equal(error.code, code)
        assert.equal(error.cause, undefined)
        assert.ok(!error.message.includes('private'))
        return true
      })
    }
  })
}
