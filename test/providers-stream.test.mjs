// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test as nodeTest } from 'node:test'
import { createOpenAIProvider } from '../dist/providers/openai.js'
import { createOpenRouterProvider } from '../dist/providers/openrouter.js'
import { runAgent } from '../dist/index.js'

const test = (name, fn) => nodeTest(name, { timeout: 3_000 }, fn)
const encoder = new TextEncoder()
const input = { messages: [{ kind: 'message', role: 'user', content: 'Use a fixture' }], tools: [
  { name: 'fixture', description: 'Offline fixture', parameters: { type: 'object' } }
] }
const signal = () => new AbortController().signal
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const frame = (data, ending = '\n', event) => `${event ? `event: ${event}${ending}` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}${ending}${ending}`
const message = (text = 'Done') => ({
  type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }]
})
const openAICompleted = (output = [message()], usage = {}) => ({
  type: 'response.completed', response: { status: 'completed', output, usage }
})
const routerChunk = (delta = {}, finish_reason = null, extra = {}) => ({
  choices: [{ index: 0, delta, finish_reason }], ...extra
})
const finalFrames = (kind, text = 'Done') => kind === 'openai'
  ? frame(openAICompleted([message(text)]))
  : frame(routerChunk({ content: text }, 'stop')) + frame('[DONE]')
function streamResponse(text, fragments = [text.length]) {
  const bytes = encoder.encode(text)
  let offset = 0
  let index = 0
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return }
      const length = fragments[index++ % fragments.length]
      controller.enqueue(bytes.slice(offset, offset + length))
      offset += length
    }
  }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
}
function factory(kind, fetch, extra = {}) {
  return (kind === 'openai' ? createOpenAIProvider : createOpenRouterProvider)({
    model: `fixture-${kind}`, apiKey: 'offline-fixture-key', stream: true, fetch, ...extra
  })
}

test('OpenAI fragmented UTF-8 SSE handles BOM, comments, CRLF/CR/LF and multiline data', async () => {
  const seen = []
  const text = '\ufeff: keepalive\r\nretry: 1000\r\nid: ignored\r\nevent: response.output_text.delta\r\n' +
    'data: {"type":"response.output_text.delta",\r\ndata: "delta":"Hi 🐈"}\r\n\r\n' +
    frame({ type: 'response.refusal.delta', delta: ' refusal' }, '\r') +
    frame({ type: 'response.reasoning_text.delta', delta: 'never display reasoning' }, '\n') +
    frame(openAICompleted([message('Hi 🐈 refusal')], { input_tokens: 2, output_tokens: 3 }), '\r\n')
  let body
  const provider = factory('openai', async (_url, init) => { body = JSON.parse(init.body); return streamResponse(text, [1, 2, 5, 3]) })
  const turn = await provider.generate(input, signal(), { onProgress: (event) => seen.push(event) })
  assert.deepEqual(seen, [{ type: 'text_delta', text: 'Hi 🐈' }, { type: 'text_delta', text: ' refusal' }])
  assert.equal(turn.content, 'Hi 🐈 refusal')
  assert.deepEqual(turn.usage, { inputTokens: 2, outputTokens: 3, totalTokens: 5 })
  assert.equal(body.stream, true)
})

test('OpenRouter fragmented stream assembles calls and native signed/encrypted reasoning with repeated usage finish', async () => {
  const seen = []
  const chunks = [
    routerChunk({ role: 'assistant', reasoning: 'private ', reasoning_details: [
      { type: 'reasoning.text', index: 0, id: 'r_1', format: 'anthropic-claude-v1', text: 'think ', signature: null }
    ] }),
    routerChunk({ content: 'Looking 🐈', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'fixture', arguments: '{"value":' } }] }),
    routerChunk({ reasoning: 'reasoning', reasoning_details: [
      { type: 'reasoning.text', index: 0, id: 'r_1', text: 'carefully', signature: 'signed' },
      { type: 'reasoning.encrypted', index: 1, data: 'opaque', id: 'r_2' }
    ], tool_calls: [{ index: 0, id: 'call_1', function: { name: 'fixture', arguments: '1}' } }] }),
    routerChunk({}, 'tool_calls'),
    routerChunk({ content: '', role: 'assistant' }, 'tool_calls', { usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 } })
  ]
  const text = ': OPENROUTER PROCESSING\r\n\r\n' + chunks.map((chunk) => frame(chunk, '\r\n')).join('') + frame('[DONE]', '\r\n')
  let body
  const provider = factory('openrouter', async (_url, init) => { body = JSON.parse(init.body); return streamResponse(text, [1, 7, 2, 13]) })
  const turn = await provider.generate(input, signal(), { onProgress: (event) => seen.push(event) })
  assert.deepEqual(seen, [{ type: 'text_delta', text: 'Looking 🐈' }])
  assert.deepEqual(turn.toolCalls, [{ id: 'call_1', name: 'fixture', arguments: { value: 1 } }])
  assert.deepEqual(turn.usage, { inputTokens: 4, outputTokens: 6, totalTokens: 10 })
  assert.equal(turn.providerState.items[0].reasoning, 'private reasoning')
  assert.deepEqual(turn.providerState.items[0].reasoning_details, [
    { type: 'reasoning.text', index: 0, id: 'r_1', format: 'anthropic-claude-v1', text: 'think carefully', signature: 'signed' },
    { type: 'reasoning.encrypted', index: 1, data: 'opaque', id: 'r_2' }
  ])
  assert.deepEqual(body.stream_options, { include_usage: true })
})

test('OpenRouter accepts an empty choices accounting frame and preserves refusal text', async () => {
  const seen = []
  const text = frame(routerChunk({ refusal: 'I cannot do that' }, 'stop')) +
    frame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } }) + frame('[DONE]')
  const provider = factory('openrouter', async () => streamResponse(text))
  const turn = await provider.generate(input, signal(), { onProgress: ({ text }) => seen.push(text) })
  assert.equal(turn.content, 'I cannot do that')
  assert.equal(turn.providerState.items[0].refusal, 'I cannot do that')
  assert.deepEqual(seen, ['I cannot do that'])
  assert.equal(turn.usage.totalTokens, 3)
})

for (const kind of ['openai', 'openrouter']) {
  test(`${kind} never produces executable partial calls; core waits for positive completion`, async () => {
    let controller
    let requests = 0
    let executions = 0
    const bodies = []
    const body = new ReadableStream({ start(value) { controller = value } })
    const provider = factory(kind, async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      requests++
      if (requests > 1) return streamResponse(finalFrames(kind))
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    })
    const run = runAgent({ provider, ...input, executeTool: async (call) => {
      assert.deepEqual(call, { id: 'call_1', name: 'fixture', arguments: { value: 1 } })
      executions++; return { content: 'fixture result' }
    } })
    await settle()
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'fixture', arguments: '{"value":1}', status: 'completed' }
    controller.enqueue(encoder.encode(kind === 'openai'
      ? frame({ type: 'response.function_call_arguments.delta', delta: '{"value":' })
      : frame(routerChunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'fixture', arguments: '{"value":' } }] }))))
    await settle()
    assert.equal(executions, 0)
    controller.enqueue(encoder.encode(kind === 'openai'
      ? frame(openAICompleted([call]))
      : frame(routerChunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'fixture', arguments: '1}' } }] }, 'tool_calls')) + frame('[DONE]')))
    const result = await run
    assert.equal(result.status, 'completed')
    assert.equal(executions, 1)
    assert.equal(result.content, 'Done')
    if (kind === 'openrouter') {
      const native = result.history.find((message) => message.kind === 'assistant' && message.toolCalls.length).providerState.items[0]
      assert.deepEqual(native.tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'fixture', arguments: '{"value":1}' } }])
      assert.deepEqual(bodies[1].messages.at(-2), native)
      assert.deepEqual(bodies[1].messages.at(-1), { role: 'tool', tool_call_id: 'call_1', content: 'fixture result' })
    }
  })

  test(`${kind} awaits async text progress in order and propagates callback rejection unchanged`, async () => {
    const gate = deferred()
    const seen = []
    const text = kind === 'openai'
      ? frame({ type: 'response.output_text.delta', delta: 'first' }) + frame({ type: 'response.output_text.delta', delta: 'second' }) + finalFrames(kind)
      : frame(routerChunk({ content: 'first' })) + frame(routerChunk({ content: 'second' }, 'stop')) + frame('[DONE]')
    const provider = factory(kind, async () => streamResponse(text))
    const generation = provider.generate(input, signal(), { async onProgress({ text }) { seen.push(text); if (text === 'first') await gate.promise } })
    await settle()
    assert.deepEqual(seen, ['first'])
    gate.resolve()
    await generation
    assert.deepEqual(seen, ['first', 'second'])
    const rejection = new Error('host callback rejection')
    await assert.rejects(provider.generate(input, signal(), { onProgress() { throw rejection } }), (error) => error === rejection)
    const core = await runAgent({ provider, ...input, executeTool: async () => ({ content: '' }), onEvent() { throw rejection } })
    assert.equal(core.status, 'error')
    assert.equal(core.error.code, 'event_error')
  })

  test(`${kind} rejects terminal errors, malformed framing payloads and incomplete streams without leaking raw errors`, async () => {
    const failures = kind === 'openai' ? [
      frame({ type: 'error', message: 'private-provider-error-key' }),
      frame({ type: 'response.failed', response: { error: { message: 'private-provider-error-key' } } }),
      frame({ type: 'response.incomplete', response: { status: 'incomplete' } }),
      frame({ type: 'response.output_text.delta', delta: 1 }),
      frame({ type: 'response.output_text.delta', delta: 'partial' }),
      frame({ type: 'response.completed', response: { status: 'incomplete', output: [] } }),
      'data: {broken}\n\n', 'data: []\n\n', frame('[DONE]'),
      'data: ' + JSON.stringify(openAICompleted()) // no blank line: spec discards final frame
    ] : [
      frame({ error: { message: 'private-provider-error-key' }, choices: [] }),
      frame(routerChunk({}, 'error')), frame(routerChunk({}, 'length')),
      frame(routerChunk({ content: 1 })), frame(routerChunk({ content: 'partial' })),
      frame(routerChunk({ content: 'Done' }, 'stop')), frame('[DONE]'),
      frame(routerChunk({ tool_calls: [{ index: 1, id: 'x', function: { name: 'fixture', arguments: '{}' } }] }, 'tool_calls')) + frame('[DONE]'),
      frame(routerChunk({ content: 'Done' }, 'stop')) + frame(routerChunk({ content: 'late' })) + frame('[DONE]'),
      frame(routerChunk({}, 'stop')) + frame(routerChunk({}, 'tool_calls')) + frame('[DONE]'),
      'data: {broken}\n\n', 'data: []\n\n', frame(routerChunk({ role: 'user' }, 'stop')) + frame('[DONE]')
    ]
    for (const text of failures) {
      const provider = factory(kind, async () => streamResponse(text, [2, 5]))
      await assert.rejects(provider.generate(input, signal()), (error) => {
        assert.ok(!error.message.includes('private-provider-error-key'))
        return true
      })
    }
  })

  test(`${kind} validates streaming content type and caps event lines and full response bytes`, async () => {
    const provider = factory(kind, async () => new Response('{}', { headers: { 'content-type': 'application/json' } }))
    await assert.rejects(provider.generate(input, signal()), /event-stream/)
    const oversized = factory(kind, async () => streamResponse('data: ' + 'x'.repeat(1_048_577)))
    await assert.rejects(oversized.generate(input, signal()), /size limit/)
    const hugeBody = factory(kind, async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16_777_217)); controller.close() } }), { headers: { 'content-type': 'text/event-stream' } }))
    await assert.rejects(hugeBody.generate(input, signal()), /size limit/)
  })

  test(`${kind} cancellation before/during credentials prevents HTTP and ignores late credential fulfillment`, async () => {
    let requests = 0
    const gate = deferred()
    const provider = factory(kind, async () => { requests++; return streamResponse(finalFrames(kind)) }, { apiKey: () => gate.promise })
    const controller = new AbortController()
    controller.abort('do-not-print-user-reason')
    await assert.rejects(provider.generate(input, controller.signal), (error) => error.name === 'AbortError' && !error.message.includes('do-not-print'))
    const next = new AbortController()
    const pending = provider.generate(input, next.signal)
    next.abort()
    await assert.rejects(pending, /cancelled/)
    gate.resolve('late-key')
    await settle()
    assert.equal(requests, 0)
  })

  test(`${kind} cancels an abort-ignoring HTTP transport and quarantines its late response`, async () => {
    const gate = deferred()
    let cancelled = false
    let transportSignal
    const provider = factory(kind, async (_url, init) => { transportSignal = init.signal; return gate.promise })
    const controller = new AbortController()
    const seen = []
    const pending = provider.generate(input, controller.signal, { onProgress: (event) => seen.push(event) })
    await settle()
    controller.abort()
    await assert.rejects(pending, /cancelled/)
    const late = new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'content-type': 'text/event-stream' } })
    gate.resolve(late)
    await settle()
    assert.equal(transportSignal.aborted, true)
    assert.equal(cancelled, true)
    assert.deepEqual(seen, [])
  })

  test(`${kind} cancellation during ordered progress suppresses buffered late deltas`, async () => {
    const gate = deferred()
    const seen = []
    const text = kind === 'openai'
      ? frame({ type: 'response.output_text.delta', delta: 'first' }) + frame({ type: 'response.output_text.delta', delta: 'late' }) + finalFrames(kind)
      : frame(routerChunk({ content: 'first' })) + frame(routerChunk({ content: 'late' }, 'stop')) + frame('[DONE]')
    const provider = factory(kind, async () => streamResponse(text))
    const controller = new AbortController()
    const pending = provider.generate(input, controller.signal, { async onProgress({ text }) { seen.push(text); await gate.promise } })
    await settle()
    controller.abort()
    await assert.rejects(pending, /cancelled/)
    gate.resolve()
    await settle()
    assert.deepEqual(seen, ['first'])
  })

  test(`${kind} finite timeout covers hung credentials, HTTP, body and progress with zero hidden retries`, async () => {
    for (const phase of ['credentials', 'http', 'body', 'progress']) {
      const gate = deferred()
      let requests = 0
      let cancelled = false
      let transportSignal
      const seen = []
      const provider = factory(kind, async (_url, init) => {
        requests++; transportSignal = init.signal
        if (phase === 'http') return gate.promise
        if (phase === 'body') return new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'content-type': 'text/event-stream' } })
        const delta = kind === 'openai' ? { type: 'response.output_text.delta', delta: 'first' } : routerChunk({ content: 'first' })
        return streamResponse(frame(delta) + finalFrames(kind))
      }, { timeoutMs: 15, ...(phase === 'credentials' ? { apiKey: () => gate.promise } : {}) })
      await assert.rejects(provider.generate(input, signal(), { async onProgress({ text }) { seen.push(text); if (phase === 'progress') await gate.promise } }), /timed out/)
      assert.equal(requests, phase === 'credentials' ? 0 : 1)
      if (transportSignal) assert.equal(transportSignal.aborted, true)
      if (phase === 'body') assert.equal(cancelled, true)
      gate.resolve(phase === 'credentials' ? 'late-key' : streamResponse(finalFrames(kind)))
      await settle()
      assert.deepEqual(seen, phase === 'progress' ? ['first'] : [])
    }
  })
}


test('OpenRouter streams nullable and omitted reasoning text/format and replays them natively', async () => {
  const variants = [
    { type: 'reasoning.text', text: null, signature: 'signed', format: 'google-gemini-v1', index: 0 },
    { type: 'reasoning.text', text: 'Thinking', signature: null, format: null, index: 0 },
    { type: 'reasoning.text', signature: 'signed', format: null, index: 0 },
    { type: 'reasoning.text', index: 0 },
  ]
  for (const detail of variants) {
    const bodies = []
    const first = frame(routerChunk({ content: 'Done', reasoning_details: [detail], tool_calls: [
      { index: 0, id: 'call_1', type: 'function', function: { name: 'fixture', arguments: '{}' } }
    ] }, 'tool_calls')) + frame('[DONE]')
    const provider = factory('openrouter', async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      return streamResponse(bodies.length === 1 ? first : finalFrames('openrouter'), [1, 5, 2])
    })
    const turn = await provider.generate(input, signal())
    assert.equal(turn.content, 'Done')
    assert.deepEqual(turn.providerState.items[0].reasoning_details, [detail])
    const persisted = JSON.parse(JSON.stringify(turn))
    await provider.generate({ ...input, messages: [...input.messages,
      { kind: 'assistant', content: persisted.content, toolCalls: persisted.toolCalls, providerState: persisted.providerState },
      { kind: 'tool_result', callId: 'call_1', name: 'fixture', content: 'fixture result' }
    ] }, signal())
    assert.deepEqual(bodies[1].messages.at(-2), persisted.providerState.items[0])
  }
})

test('OpenRouter reasoning fragments retain explicit nulls without inventing missing text', async () => {
  const text = frame(routerChunk({ reasoning_details: [
    { type: 'reasoning.text', id: 'r_1', index: 0, signature: 'signed', format: null }
  ] })) + frame(routerChunk({ content: 'Done', reasoning_details: [
    { type: 'reasoning.text', id: 'r_1', index: 0, text: null, signature: null, format: null }
  ] }, 'stop')) + frame('[DONE]')
  const provider = factory('openrouter', async () => streamResponse(text, [2, 3]))
  const turn = await provider.generate(input, signal())
  assert.deepEqual(turn.providerState.items[0].reasoning_details, [
    { type: 'reasoning.text', id: 'r_1', index: 0, signature: 'signed', format: null, text: null }
  ])
})

test('OpenRouter streaming still rejects wrong nonnull reasoning text/format/signature types', async () => {
  for (const detail of [
    { type: 'reasoning.text', text: 4 }, { type: 'reasoning.text', text: [] },
    { type: 'reasoning.text', text: {}, format: null },
    { type: 'reasoning.text', text: null, format: 4 },
    { type: 'reasoning.text', text: 'Thinking', format: {} },
    { type: 'reasoning.text', signature: true },
    { type: 'reasoning.summary', summary: null }, { type: 'reasoning.encrypted', data: null }
  ]) {
    const text = frame(routerChunk({ content: 'Done', reasoning_details: [detail] }, 'stop')) + frame('[DONE]')
    const provider = factory('openrouter', async () => streamResponse(text))
    await assert.rejects(provider.generate(input, signal()), /invalid reasoning/i)
  }
})


test('OpenRouter same-index summary-to-encrypted transitions and discrete encrypted blocks replay exactly', async () => {
  const firstSummary = { type: 'reasoning.summary', index: 0, id: 'rs1', summary: 'Think', format: 'openai-responses-v1' }
  const summaryContinuation = { type: 'reasoning.summary', index: 0, id: 'rs1', summary: 'ing' }
  const encrypted = [
    { type: 'reasoning.encrypted', index: 0, id: 'rs1', data: 'opaque-first', format: 'openai-responses-v1' },
    { type: 'reasoning.encrypted', index: 0, id: 'rs2', data: 'opaque-second', format: 'openai-responses-v1' },
    { type: 'reasoning.encrypted', index: 0, id: 'rs2', data: 'opaque-third', format: 'openai-responses-v1' }
  ]
  const finalSummary = { type: 'reasoning.summary', index: 0, id: 'rs3', summary: 'New block', format: null }
  const expected = [{ ...firstSummary, summary: 'Thinking' }, ...encrypted, finalSummary]
  const text = [firstSummary, summaryContinuation, ...encrypted, finalSummary]
    .map((detail) => frame(routerChunk({ reasoning_details: [detail] }))).join('') +
    frame(routerChunk({ content: 'Done', tool_calls: [
      { index: 0, id: 'call_1', type: 'function', function: { name: 'fixture', arguments: '{}' } }
    ] }, 'stop')) + frame('[DONE]')
  const bodies = []
  const provider = factory('openrouter', async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return streamResponse(bodies.length === 1 ? text : finalFrames('openrouter'), [1, 8, 3])
  })
  const turn = await provider.generate(input, signal())
  assert.deepEqual(turn.providerState.items[0].reasoning_details, expected)
  const persisted = JSON.parse(JSON.stringify(turn))
  await provider.generate({ ...input, messages: [...input.messages,
    { kind: 'assistant', content: persisted.content, toolCalls: persisted.toolCalls, providerState: persisted.providerState },
    { kind: 'tool_result', callId: 'call_1', name: 'fixture', content: 'fixture result' }
  ] }, signal())
  assert.deepEqual(bodies[1].messages.at(-2).reasoning_details, expected)
  assert.deepEqual(bodies[1].messages.at(-2), persisted.providerState.items[0])
})

test('OpenRouter merges consecutive reasoning text by type and preserves opaque signatures without concatenation', async () => {
  const text = frame(routerChunk({ reasoning_details: [
    { type: 'reasoning.text', text: 'Think', signature: null, format: null, index: 0, id: 'text1' }
  ] })) + frame(routerChunk({ reasoning_details: [
    { type: 'reasoning.text', text: 'ing', signature: 'signed', format: 'google-gemini-v1', index: 1, id: 'text2' }
  ] })) + frame(routerChunk({ reasoning_details: [
    { type: 'reasoning.text', signature: 'signed', format: 'google-gemini-v1', index: 0, id: 'text1' }
  ] })) + frame(routerChunk({ content: 'Done' }, 'stop')) + frame('[DONE]')
  const provider = factory('openrouter', async () => streamResponse(text, [2, 4]))
  const turn = await provider.generate(input, signal())
  assert.deepEqual(turn.providerState.items[0].reasoning_details, [
    { type: 'reasoning.text', text: 'Thinking', signature: 'signed', format: 'google-gemini-v1', index: 0, id: 'text1' }
  ])
})


test('OpenRouter rejects conflicting repeated call IDs or names before any core dispatch', async () => {
  for (const changed of [
    { id: 'private-conflicting-call-id', function: { name: 'fixture', arguments: '1}' } },
    { id: 'call_1', function: { name: 'private-conflicting-tool-name', arguments: '1}' } },
    { id: 'call_1', type: 'custom', function: { name: 'fixture', arguments: '1}' } }
  ]) {
    const text = frame(routerChunk({ tool_calls: [
      { index: 0, id: 'call_1', type: 'function', function: { name: 'fixture', arguments: '{"a":' } }
    ] })) + frame(routerChunk({ tool_calls: [{ index: 0, ...changed }] }, 'tool_calls')) + frame('[DONE]')
    const provider = factory('openrouter', async () => streamResponse(text, [1, 4, 2]))
    let executions = 0
    const result = await runAgent({ provider, ...input, executeTool: async () => { executions++; return { content: '' } } })
    assert.equal(result.status, 'error')
    assert.equal(result.error.code, 'provider_error')
    assert.equal(executions, 0)
    assert.ok(!result.error.message.includes('private-conflicting'))
    assert.deepEqual(result.history, input.messages)
  }
})
