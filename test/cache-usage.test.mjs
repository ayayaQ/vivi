// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test as nodeTest } from 'node:test'
import { runAgent } from '../dist/index.js'
import { createOpenAIProvider } from '../dist/providers/openai.js'
import { createOpenRouterProvider } from '../dist/providers/openrouter.js'

const test = (name, fn) => nodeTest(name, { timeout: 3_000 }, fn)
const base = { inputTokens: 12, outputTokens: 4, totalTokens: 19 }
const empty = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
const keys = ['cachedInputTokens', 'cacheWriteInputTokens']
const tool = { name: 'fixture', description: 'Offline fixture', parameters: { type: 'object' } }
const call = { id: 'fixture-1', name: 'fixture', arguments: {} }
const input = { messages: [], tools: [tool] }
const signal = () => new AbortController().signal
const frame = (data) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
const encoded = (text) => new TextEncoder().encode(text)
const sseResponse = (text) => new Response(new ReadableStream({ start(controller) {
  // Split UTF-8/SSE frames so streaming uses the actual assembler, not the JSON path.
  const bytes = encoded(text)
  for (let offset = 0; offset < bytes.length; offset += 13) controller.enqueue(bytes.slice(offset, offset + 13))
  controller.close()
} }), { headers: { 'content-type': 'text/event-stream' } })
const wireUsage = (kind, details = undefined, fields = {}) => ({
  [kind === 'openai' ? 'input_tokens' : 'prompt_tokens']: 12,
  [kind === 'openai' ? 'output_tokens' : 'completion_tokens']: 4,
  total_tokens: 19,
  ...(details !== undefined ? { [kind === 'openai' ? 'input_tokens_details' : 'prompt_tokens_details']: details } : {}),
  ...fields
})
const native = (kind, toolRound = false) => kind === 'openai'
  ? [{ type: 'message', id: 'msg-1', role: 'assistant', content: [{ type: 'output_text', text: 'Done', annotations: [] }] },
    ...(toolRound ? [{ type: 'function_call', call_id: call.id, name: call.name, arguments: '{}' }] : [])]
  : { role: 'assistant', content: 'Done', ...(toolRound ? { tool_calls: [
    { id: call.id, type: 'function', function: { name: call.name, arguments: '{}' } }
  ] } : {}) }
function response(kind, stream, usage, toolRound = false, rawJson) {
  const item = native(kind, toolRound)
  const value = kind === 'openai'
    ? { status: 'completed', output: item, ...(usage !== undefined ? { usage } : {}) }
    : { choices: [{ message: item, finish_reason: toolRound ? 'tool_calls' : 'stop' }], ...(usage !== undefined ? { usage } : {}) }
  if (!stream) return new Response(rawJson ?? JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  if (kind === 'openai') return sseResponse(frame({ type: 'response.output_text.delta', delta: 'Done' }) +
    (rawJson ? `data: {"type":"response.completed","response":${rawJson}}\n\n` : frame({ type: 'response.completed', response: value })))
  const delta = { ...item }
  if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((entry, index) => ({ index, ...entry }))
  // Repeat a cumulative accounting snapshot before/after finish: it must never be added twice.
  return sseResponse(frame({ choices: [{ index: 0, delta, finish_reason: null }], ...(usage !== undefined ? { usage } : {}) }) +
    frame({ choices: [{ index: 0, delta: {}, finish_reason: toolRound ? 'tool_calls' : 'stop' }] }) +
    (rawJson ? `data: {"choices":[],"usage":${rawJson}}\n\n` :
      (usage !== undefined ? frame({ choices: [], usage }) : '')) + frame('[DONE]'))
}
function provider(kind, stream, replies, requests = []) {
  const factory = kind === 'openai' ? createOpenAIProvider : createOpenRouterProvider
  return factory({ model: `offline-${kind}`, apiKey: 'offline-fixture-key', stream, fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body))
    assert.ok(replies.length, 'Unexpected mock request')
    const next = replies.shift()
    return typeof next === 'function' ? next(init) : next
  } })
}

const cases = [
  ['missing details', undefined, {}], ['empty details', {}, {}], ['null details', null, {}],
  ['cache read only', { cached_tokens: 7 }, { cachedInputTokens: 7 }],
  ['cache write only', { cache_write_tokens: 5 }, { cacheWriteInputTokens: 5 }],
  ['both counters', { cached_tokens: 7, cache_write_tokens: 5 }, { cachedInputTokens: 7, cacheWriteInputTokens: 5 }],
  ['explicit zeros', { cached_tokens: 0, cache_write_tokens: 0 }, { cachedInputTokens: 0, cacheWriteInputTokens: 0 }],
  ['null counters', { cached_tokens: null, cache_write_tokens: null }, {}],
  ['unrelated details', { audio_tokens: 1, future_details: { count: 3 } }, {}],
  ['read zero/write absent', { cached_tokens: 0 }, { cachedInputTokens: 0 }],
  ['write zero/read absent', { cache_write_tokens: 0 }, { cacheWriteInputTokens: 0 }],
  ['read null/write zero', { cached_tokens: null, cache_write_tokens: 0 }, { cacheWriteInputTokens: 0 }]
]
for (const kind of ['openai', 'openrouter']) {
  for (const stream of [false, true]) {
    const mode = `${kind} ${stream ? 'streaming' : 'nonstreaming'}`
    test(`${mode} preserves optional cache counts independently and keeps existing totals`, async () => {
      for (const [label, details, expected] of cases) {
        const turn = await provider(kind, stream, [response(kind, stream, wireUsage(kind, details))]).generate(input, signal())
        assert.deepEqual(turn.usage, { ...base, ...expected }, label)
        for (const key of keys) assert.equal(Object.hasOwn(turn.usage, key), Object.hasOwn(expected, key), label)
      }
      for (const missing of [undefined, null, {}]) {
        const turn = await provider(kind, stream, [response(kind, stream, missing)]).generate(input, signal())
        assert.deepEqual(turn.usage, empty)
      }
      const counts = wireUsage(kind, { cached_tokens: 7, cache_write_tokens: 5 }, { total_tokens: null })
      const turn = await provider(kind, stream, [response(kind, stream, counts)]).generate(input, signal())
      assert.deepEqual(turn.usage, { ...base, totalTokens: 16, cachedInputTokens: 7, cacheWriteInputTokens: 5 })
      const wrongDetails = { [kind === 'openai' ? 'prompt_tokens_details' : 'input_tokens_details']: { cached_tokens: 9 } }
      const wrong = await provider(kind, stream, [response(kind, stream, wireUsage(kind, undefined, wrongDetails))]).generate(input, signal())
      assert.deepEqual(wrong.usage, base)
    })
    test(`${mode} rejects malformed cache detail containers and counts with sanitized errors`, async () => {
      const badContainers = ['private-usage-detail', 1, false, []]
      const badCounts = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'private-usage-detail', false, {}, []]
      for (const details of [...badContainers, ...badCounts.flatMap((count) => [
        { cached_tokens: count }, { cache_write_tokens: count }, { cached_tokens: 0, cache_write_tokens: count }
      ])]) {
        const mocked = provider(kind, stream, [response(kind, stream, wireUsage(kind, details))])
        await assert.rejects(mocked.generate(input, signal()), (error) => {
          assert.equal(error.code, 'invalid_response')
          assert.equal(error.message.includes('private-usage-detail'), false)
          return true
        })
      }
      // JSON permits an overflowing exponent; count validation must still reject Infinity.
      const usage = JSON.stringify(wireUsage(kind, { cached_tokens: 0, cache_write_tokens: 0 })).replace('"cached_tokens":0', '"cached_tokens":1e309')
      const raw = kind === 'openai' || !stream
        ? JSON.stringify(kind === 'openai' ? { status: 'completed', output: native(kind), usage: {} } :
          { choices: [{ message: native(kind), finish_reason: 'stop' }], usage: {} }).replace('"usage":{}', `"usage":${usage}`)
        : usage
      await assert.rejects(provider(kind, stream, [response(kind, stream, {}, false, raw)]).generate(input, signal()), { code: 'invalid_response' })
    })
    test(`${mode} carries cache counts through tool continuation, events, and fresh runs`, async () => {
      const requests = []
      const mocked = provider(kind, stream, [
        response(kind, stream, wireUsage(kind, { cached_tokens: 2, cache_write_tokens: 3 }), true),
        response(kind, stream, wireUsage(kind, { cached_tokens: 5, cache_write_tokens: 0 })),
        response(kind, stream, wireUsage(kind, { cached_tokens: 1, cache_write_tokens: 0 }))
      ], requests)
      const events = []
      const first = await runAgent({ provider: mocked, ...input,
        async executeTool() { return { content: 'fixture result' } },
        onEvent(event) { if (event.type === 'round_completed') {
          assert.equal(Object.isFrozen(event.usage), true)
          assert.throws(() => { event.usage.cachedInputTokens = 99 }, TypeError)
          events.push(event)
        } }
      })
      assert.equal(first.status, 'completed')
      assert.equal(first.rounds, 2)
      assert.deepEqual(first.usage, { inputTokens: 24, outputTokens: 8, totalTokens: 38, cachedInputTokens: 7, cacheWriteInputTokens: 3 })
      assert.deepEqual(events.map((event) => event.usage), [
        { ...base, cachedInputTokens: 2, cacheWriteInputTokens: 3 }, { ...base, cachedInputTokens: 5, cacheWriteInputTokens: 0 }
      ])
      const second = await runAgent({ provider: mocked, messages: first.history, tools: [], async executeTool() { throw Error('unexpected tool') } })
      assert.equal(second.status, 'completed')
      assert.deepEqual(second.usage, { ...base, cachedInputTokens: 1, cacheWriteInputTokens: 0 })
      const continuation = requests[1][kind === 'openai' ? 'input' : 'messages']
      assert.ok(continuation.some((entry) => entry.type === 'function_call_output' || entry.role === 'tool'))
      for (const body of requests) {
        for (const field of ['prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options', 'cache_control', 'session_id']) {
          assert.equal(Object.hasOwn(body, field), false)
        }
      }
    })
  }
}

async function coreRun(usages, extras = {}) {
  let index = 0
  const events = []
  const result = await runAgent({ ...input, provider: { async generate() {
    const usage = usages[index]
    const final = ++index === usages.length
    return { content: 'Done', toolCalls: final ? [] : [{ ...call, id: `round-${index}` }], ...(usage !== undefined ? { usage } : {}) }
  } }, async executeTool() { return { content: 'Done' } }, onEvent(event) { events.push(event) }, ...extras })
  return { result, events }
}
test('core cache aggregation requires complete reporting independently for each field', async () => {
  const both = { ...base, cachedInputTokens: 2, cacheWriteInputTokens: 3 }
  for (const [usages, expected] of [
    [[both, both, both], { cachedInputTokens: 6, cacheWriteInputTokens: 9 }],
    [[base, both, both], {}], [[both, base, both], {}], [[both, both, base], {}],
    [[{ ...both, cacheWriteInputTokens: 0 }, { ...base, cachedInputTokens: 0 }, both], { cachedInputTokens: 4 }],
    [[both, { ...base, cacheWriteInputTokens: 0 }, both], { cacheWriteInputTokens: 6 }],
    [[{ ...base, cachedInputTokens: 0, cacheWriteInputTokens: 0 }, { ...base, cachedInputTokens: 0, cacheWriteInputTokens: 0 }], { cachedInputTokens: 0, cacheWriteInputTokens: 0 }],
    [[both, undefined, both], {}], [[undefined, both], {}]
  ]) {
    const { result, events } = await coreRun(usages)
    assert.equal(result.status, 'completed')
    const reported = usages.filter((usage) => usage !== undefined).length
    assert.deepEqual(result.usage, { inputTokens: 12 * reported, outputTokens: 4 * reported, totalTokens: 19 * reported, ...expected })
    assert.deepEqual(events.filter((event) => event.type === 'round_completed').map((event) => event.usage), usages)
  }
  assert.deepEqual((await coreRun([undefined, undefined])).result.usage, empty)
})

test('core rejects invalid optional counts before committing or executing tools', async () => {
  for (const key of keys) {
    for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, null, undefined, true, '0', {}, []]) {
      let executions = 0
      const { result, events } = await coreRun([{ ...base, [key]: invalid }, base], {
        async executeTool() { executions++; return { content: 'Done' } }
      })
      assert.equal(result.status, 'error')
      assert.equal(result.error.code, 'invalid_provider_output')
      assert.equal(result.rounds, 0)
      assert.deepEqual(result.history, [])
      assert.deepEqual(result.usage, empty)
      assert.deepEqual(events, [])
      assert.equal(executions, 0)
    }
  }
})

test('core rejects optional aggregate overflow before committing the offending round', async () => {
  for (const key of keys) {
    const first = { ...empty, [key]: Number.MAX_SAFE_INTEGER }
    const { result } = await coreRun([first, { ...empty, [key]: 1 }])
    assert.equal(result.status, 'error')
    assert.equal(result.error.code, 'invalid_provider_output')
    assert.equal(result.rounds, 1)
    assert.deepEqual(result.usage, first)
  }
})

test('cancelled and event-error results retain cache usage from committed rounds only', async () => {
  const count = { ...base, cachedInputTokens: 2, cacheWriteInputTokens: 0 }
  const controller = new AbortController()
  let calls = 0
  let secondStarted
  const started = new Promise((resolve) => { secondStarted = resolve })
  const pending = runAgent({ ...input, signal: controller.signal, provider: { async generate() {
    if (++calls === 1) return { content: 'Done', toolCalls: [call], usage: count }
    secondStarted()
    return new Promise(() => {})
  } }, async executeTool() { return { content: 'Done' } } })
  await started
  controller.abort()
  const cancelled = await pending
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.rounds, 1)
  assert.deepEqual(cancelled.usage, count)
  const duringTool = new AbortController()
  const { result } = await coreRun([count, count], { signal: duringTool.signal,
    async executeTool() { duringTool.abort(); return { content: 'Done' } }
  })
  assert.equal(result.status, 'cancelled')
  assert.deepEqual(result.usage, count)
  assert.equal(result.history.at(-1).isError, true)
  const eventFailure = await coreRun([count], { onEvent() { throw Error('fixture hook failure') } })
  assert.equal(eventFailure.result.error.code, 'event_error')
  assert.deepEqual(eventFailure.result.usage, count)
  const before = new AbortController()
  before.abort()
  assert.deepEqual((await coreRun([count], { signal: before.signal })).result.usage, empty)
})

for (const kind of ['openai', 'openrouter']) {
  test(`${kind} streamed accounting from an unfinished second round never enters aggregate usage`, async () => {
    const controller = new AbortController()
    let bodyController
    let secondStarted
    const started = new Promise((resolve) => { secondStarted = resolve })
    const second = () => {
      const body = new ReadableStream({ start(value) { bodyController = value } })
      secondStarted()
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }
    const count = wireUsage(kind, { cached_tokens: 2, cache_write_tokens: 0 })
    const mocked = provider(kind, true, [response(kind, true, count, true), second])
    const pending = runAgent({ provider: mocked, ...input, signal: controller.signal, async executeTool() { return { content: 'Done' } } })
    await started
    bodyController.enqueue(encoded(frame(kind === 'openai'
      ? { type: 'response.created', response: { usage: wireUsage(kind, { cached_tokens: 12, cache_write_tokens: 0 }) } }
      : { choices: [], usage: wireUsage(kind, { cached_tokens: 12, cache_write_tokens: 0 }) })))
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort()
    const result = await pending
    assert.equal(result.status, 'cancelled')
    assert.equal(result.rounds, 1)
    assert.deepEqual(result.usage, { ...base, cachedInputTokens: 2, cacheWriteInputTokens: 0 })
  })
}
