// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test as nodeTest } from 'node:test'
import { createDeepSeekProvider, projectDeepSeekHistory, isContextOverflow } from '../dist/providers/deepseek.js'
import { runAgent } from '../dist/index.js'

const test = (name, fn) => nodeTest(name, { timeout: 5000 }, fn)
const signal = () => new AbortController().signal
const tool = { name: 'read_state', description: 'Read the named state', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
const input = { messages: [{ kind: 'message', role: 'user', content: 'Read the state' }], tools: [tool] }
const call = (id = 'call-1', name = 'read_state', args = '{"path":"a"}') => ({ id, type: 'function', function: { name, arguments: args } })
const answer = (content = 'Done', calls = [], reasoning = 'retained native reasoning', counts) => ({
  choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content, reasoning_content: reasoning, ...(calls.length ? { tool_calls: calls } : {}) } }],
  ...(counts !== undefined ? { usage: counts } : {})
})
const frame = value => `data: ${JSON.stringify(value)}\n\n`
const chunk = (delta = {}, finish_reason = null, usage) => ({ choices: [{ index: 0, delta, finish_reason }], ...(usage !== undefined ? { usage } : {}) })
const sse = value => new Response(value, { headers: { 'content-type': 'text/event-stream' } })
const privateValue = 'private-key-url-upstream-details'
function harness(responses = [answer()], options = {}) {
  const requests = []; let credentials = 0
  const provider = createDeepSeekProvider({ apiKey: () => { credentials++; return privateValue }, model: 'deepseek-flash',
    fetch: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) })
      const response = responses.shift()
      if (!response) assert.fail('Unexpected retry or extra request')
      return response instanceof Response ? response : new Response(JSON.stringify(response))
    }, ...options })
  return { provider, requests, credentials: () => credentials }
}
function history(content = 'First answer', reasoning = 'first answer reasoning', model = 'deepseek-flash', calls = []) {
  return { kind: 'assistant', content, toolCalls: calls.map(c => ({ id: c.id, name: c.function.name, arguments: JSON.parse(c.function.arguments) })),
    providerState: { provider: `deepseek:${model}`, items: [{ role: 'assistant', content, reasoning_content: reasoning, ...(calls.length ? { tool_calls: calls } : {}) }] } }
}

test('DeepSeek uses its own endpoint, native state, omitted thinking default, and output budget', async () => {
  const h = harness([answer('Inspecting', [call()], 'native-only')])
  const result = await h.provider.generate(input, signal(), { maxOutputTokens: 8192, purpose: 'response', reservedToolCallIds: ['reserved'] })
  assert.equal(h.requests[0].url, 'https://api.deepseek.com/chat/completions')
  const { body, init } = h.requests[0]
  assert.equal(init.redirect, 'error')
  assert.equal(init.headers.Authorization, `Bearer ${privateValue}`)
  assert.equal(body.max_tokens, 8192)
  for (const field of ['reasoning', 'reasoning_effort', 'thinking', 'purpose', 'reservedToolCallIds', 'provider', 'store']) assert.equal(Object.hasOwn(body, field), false)
  assert.equal(body.tools[0].function.name, tool.name)
  assert.deepEqual(result.toolCalls, [{ id: 'call-1', name: 'read_state', arguments: { path: 'a' } }])
  assert.equal(result.providerState.provider, 'deepseek:deepseek-flash')
  assert.equal(result.providerState.items[0].reasoning_content, 'native-only')
  assert.equal(result.content, 'Inspecting')
})

test('DeepSeek reasoning overrides require explicit capability support and use native parameters', async () => {
  for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.throws(() => createDeepSeekProvider({ apiKey: 'fake', model: 'm', reasoning: { mode: 'effort', effort } }), { code: 'configuration', provider: 'DeepSeek' })
    const h = harness([answer()], { reasoning: { mode: 'effort', effort }, supportedReasoningEfforts: [effort] })
    await h.provider.generate(input, signal())
    assert.equal(h.requests[0].body.reasoning_effort, effort)
    assert.equal(Object.hasOwn(h.requests[0].body, 'reasoning'), false)
  }
  assert.throws(() => createDeepSeekProvider({ apiKey: 'fake', model: 'm', reasoning: { mode: 'disabled' } }), { code: 'configuration' })
  const h = harness([answer()], { reasoning: { mode: 'disabled' }, supportedReasoningEfforts: ['none'] })
  await h.provider.generate(input, signal())
  assert.deepEqual(h.requests[0].body.thinking, { type: 'disabled' })
  assert.equal(Object.hasOwn(h.requests[0].body, 'reasoning_effort'), false)
  for (const options of [{ reasoning: { mode: 'effort', effort: 'ultra' }, supportedReasoningEfforts: ['ultra'] },
    { model: '' }, { apiKey: '' }, { stream: 'true' }, { timeoutMs: 0 }, { baseURL: 'https://u:p@example.test' },
    { baseURL: 'https://example.test?key=secret' }, { baseURL: 'http://example.test' }]) {
    assert.throws(() => createDeepSeekProvider({ apiKey: 'fake', model: 'm', ...options }), { code: 'configuration', provider: 'DeepSeek' })
  }
})

test('all prior assistant reasoning survives text-only turns, tool groups, and later turns', async () => {
  const previous = history()
  const h = harness([answer('Inspecting', [call('a'), call('b', 'read_state', '{"path":"b"}')], 'tool reasoning'), answer('Complete', [], 'final reasoning')])
  const result = await runAgent({ provider: h.provider, messages: [...input.messages, previous, { kind: 'message', role: 'user', content: 'Now inspect both' }], tools: input.tools,
    async executeTool(call) { return { content: `state:${call.arguments.path}` } } })
  assert.equal(result.status, 'completed')
  assert.equal(h.requests[0].body.messages[1].reasoning_content, 'first answer reasoning')
  const sent = h.requests[1].body.messages
  assert.equal(sent[1].reasoning_content, 'first answer reasoning')
  assert.equal(sent[3].reasoning_content, 'tool reasoning')
  assert.deepEqual(sent.slice(-2), [{ role: 'tool', tool_call_id: 'a', content: 'state:a' }, { role: 'tool', tool_call_id: 'b', content: 'state:b' }])
  const continuation = projectDeepSeekHistory([...result.history, { kind: 'message', role: 'user', content: 'Continue' }], 'deepseek-flash', { tools: true })
  assert.equal(continuation.at(-2).reasoning_content, 'final reasoning')
})

test('foreign provider/model state never leaks and inconsistent same-model state fails closed', () => {
  for (const provider of ['openrouter:deepseek-flash', 'openai:deepseek-flash', 'deepseek:deepseek-v4-pro']) {
    const message = history(); message.providerState.provider = provider
    assert.deepEqual(projectDeepSeekHistory([message], 'deepseek-flash'), [{ role: 'assistant', content: 'First answer' }])
    assert.throws(() => projectDeepSeekHistory([message], 'deepseek-flash', { tools: true }), { code: 'configuration' })
  }
  for (const mutate of [m => { m.content += ' changed' }, m => { m.providerState.items[0].reasoning_content = {} }, m => { m.providerState.items = [] }]) {
    const message = history(); mutate(message)
    assert.throws(() => projectDeepSeekHistory([message], 'deepseek-flash'), { code: 'configuration' })
  }
  const original = history(); const before = structuredClone(original)
  assert.equal(Object.hasOwn(projectDeepSeekHistory([original], 'deepseek-flash', { tools: false })[0], 'reasoning_content'), false)
  assert.deepEqual(original, before)
})

test('provider/model switching and missing native state fail before HTTP instead of synthesizing tool history', async () => {
  for (const source of ['openai:foreign', 'openrouter:foreign', 'deepseek:deepseek-v4-pro', undefined]) {
    for (const withCalls of [true, false]) {
      const previous = history('Prior answer', 'foreign reasoning', 'deepseek-flash', withCalls ? [call('prior-call')] : [])
      if (source === undefined) delete previous.providerState
      else previous.providerState.provider = source
      const messages = [...input.messages, previous, ...(withCalls ? [{ kind: 'tool_result', callId: 'prior-call', name: 'read_state', content: 'previous result' }] : []), { kind: 'message', role: 'user', content: 'Continue' }]
      const seed = { messages, tools: [tool] }
      const h = harness()
      assert.throws(() => h.provider.estimateContext(seed), { code: 'configuration' })
      await assert.rejects(h.provider.generate(seed, signal()), { code: 'configuration' })
      assert.equal(h.requests.length, 0)
      if (withCalls) {
        for (const tools of [[], [tool]]) {
          const disabled = harness([answer()], { reasoning: { mode: 'disabled' }, supportedReasoningEfforts: ['none'] })
          await assert.rejects(disabled.provider.generate({ messages, tools }, signal()), { code: 'configuration' })
          assert.equal(disabled.requests.length, 0)
        }
      } else {
        const portable = harness([answer()])
        await portable.provider.generate({ messages, tools: [] }, signal())
        assert.equal(Object.hasOwn(portable.requests[0].body.messages[1], 'reasoning_content'), false)
        const disabled = harness([answer()], { reasoning: { mode: 'disabled' }, supportedReasoningEfforts: ['none'] })
        await disabled.provider.generate(seed, signal())
        assert.deepEqual(disabled.requests[0].body.thinking, { type: 'disabled' })
      }
    }
  }
  for (const reasoning of [undefined, null]) {
    const previous = history(); previous.providerState.items[0].reasoning_content = reasoning
    if (reasoning === undefined) delete previous.providerState.items[0].reasoning_content
    const h = harness()
    await assert.rejects(h.provider.generate({ messages: [...input.messages, previous], tools: [tool] }, signal()), { code: 'configuration' })
    assert.equal(h.requests.length, 0)
  }
})

test('history results must pair exact IDs and names in order before HTTP dispatch', async () => {
  const first = history('Inspecting', 'native', 'deepseek-flash', [call('a'), call('b')])
  for (const results of [[], [{ kind: 'tool_result', callId: 'b', name: 'read_state', content: 'out-of-order' }],
    [{ kind: 'tool_result', callId: 'a', name: 'wrong', content: 'wrong name' }],
    [{ kind: 'tool_result', callId: 'a', name: 'read_state', content: 'one only' }]]) {
    const h = harness()
    await assert.rejects(h.provider.generate({ messages: [...input.messages, first, ...results], tools: [tool] }, signal()), { code: 'configuration' })
    assert.equal(h.requests.length, 0)
  }
  const getter = Object.defineProperty({}, 'kind', { enumerable: true, get() { assert.fail('Never invoke getter') } })
  assert.throws(() => projectDeepSeekHistory([getter], 'deepseek-flash'), { code: 'configuration' })
})

test('thinking with tools rejects uncontinuable calls before canonical acceptance or execution', async () => {
  for (const reasoning of [undefined, null]) {
    const response = answer('Inspecting', [call()], reasoning)
    if (reasoning === undefined) delete response.choices[0].message.reasoning_content
    const h = harness([response])
    const result = await runAgent({ provider: h.provider, ...input, async executeTool() { assert.fail('An uncontinuable call must not execute') } })
    assert.equal(result.status, 'error'); assert.equal(result.rounds, 0); assert.deepEqual(result.history, input.messages)
  }
  const tools = [{ index: 0, ...call() }]
  const stream = harness([sse(frame(chunk({ tool_calls: tools }, 'tool_calls')) + 'data: [DONE]\n\n')], { stream: true })
  const result = await runAgent({ provider: stream.provider, ...input, async executeTool() { assert.fail('Streaming omission must not execute') } })
  assert.equal(result.status, 'error'); assert.equal(result.rounds, 0); assert.deepEqual(result.history, input.messages)
  const first = answer('Inspecting', [call()], null)
  const disabled = harness([first, answer()], { reasoning: { mode: 'disabled' }, supportedReasoningEfforts: ['none'] })
  const completed = await runAgent({ provider: disabled.provider, ...input, async executeTool() { return { content: 'read result' } } })
  assert.equal(completed.status, 'completed'); assert.equal(completed.rounds, 2)
  const empty = await harness([answer('Done', [], '')]).provider.generate(input, signal())
  assert.equal(empty.providerState.items[0].reasoning_content, '')
  const textResponse = answer('Final text', [], null)
  const plain = harness([textResponse]); const textOnly = await plain.provider.generate(input, signal())
  assert.equal(textOnly.content, 'Final text')
  assert.throws(() => plain.provider.estimateContext({ messages: [...input.messages, { kind: 'assistant', ...textOnly }], tools: [tool] }), { code: 'configuration' })
})

test('native reasoning-associated tool IDs cannot be reused, duplicated, or silently renamed', async () => {
  for (const calls of [[call('same'), call('same')], [call('reserved')]]) {
    const h = harness([answer('', calls)])
    await assert.rejects(h.provider.generate(input, signal(), { reservedToolCallIds: ['reserved'] }), { code: 'invalid_response' })
  }
  const previous = history('Inspect', 'native', 'deepseek-flash', [call('same')])
  const h = harness([answer('', [call('same')])])
  await assert.rejects(h.provider.generate({ messages: [...input.messages, previous,
    { kind: 'tool_result', callId: 'same', name: 'read_state', content: 'old result' }], tools: [tool] }, signal()), { code: 'invalid_response' })
})

test('streaming separates reasoning and text, retains stable tool IDs, and accepts final-chunk usage', async () => {
  const counts = { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, prompt_cache_hit_tokens: 12, prompt_cache_miss_tokens: 8, completion_tokens_details: { reasoning_tokens: 5 } }
  const data = [chunk({ role: 'assistant', reasoning_content: 'think ' }), chunk({ reasoning_content: 'carefully', content: 'Inspect ' }),
    chunk({ content: '世界 now', tool_calls: [{ index: 0, id: 'native-id', type: 'function', function: { name: 'read_state', arguments: '{"path":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }), chunk({}, 'tool_calls', counts)].map(frame).join('') + 'data: [DONE]\n\n'
  // Deliberately split at every UTF-8 byte, exercising transport framing and ordered progress.
  const bytes = new TextEncoder().encode(data)
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close() } }), { headers: { 'content-type': 'text/event-stream' } })
  const h = harness([response], { stream: true }); const progress = []
  const result = await h.provider.generate(input, signal(), { async onProgress(event) { progress.push(event); await Promise.resolve() } })
  assert.deepEqual(progress, [{ type: 'text_delta', text: 'Inspect ' }, { type: 'text_delta', text: '世界 now' }])
  assert.equal(result.providerState.items[0].reasoning_content, 'think carefully')
  assert.deepEqual(result.toolCalls, [{ id: 'native-id', name: 'read_state', arguments: { path: 'a' } }])
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 8, totalTokens: 28, cachedInputTokens: 12 })
  assert.deepEqual(h.requests[0].body.stream_options, { include_usage: true })
})

test('streaming refuses unfinished, conflicting, truncated, and failed tool output', async () => {
  const toolDelta = { tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'read_state', arguments: '{"path":"a"}' } }] }
  const streams = [
    frame(chunk(toolDelta)), frame(chunk(toolDelta)) + 'data: [DONE]\n\n',
    frame(chunk(toolDelta, 'length')) + 'data: [DONE]\n\n',
    frame(chunk(toolDelta)) + frame(chunk({ tool_calls: [{ index: 0, id: 'changed' }] }, 'tool_calls')) + 'data: [DONE]\n\n',
    frame(chunk(toolDelta, 'tool_calls')) + frame(chunk({ content: 'too late' })) + 'data: [DONE]\n\n',
    frame(chunk({ tool_calls: [{ ...toolDelta.tool_calls[0], index: 1 }] }, 'tool_calls')) + 'data: [DONE]\n\n',
    frame({ choices: [] }) + 'data: [DONE]\n\n',
    frame(chunk({}, 'content_filter')) + 'data: [DONE]\n\n',
    frame(chunk({}, 'insufficient_system_resource')) + 'data: [DONE]\n\n',
    frame(chunk({}, 'aborted')) + 'data: [DONE]\n\n'
  ]
  for (const text of streams) {
    const h = harness([sse(text)], { stream: true })
    const result = await runAgent({ provider: h.provider, ...input, async executeTool() { assert.fail('Incomplete calls must never execute') } })
    assert.equal(result.status, 'error')
    assert.equal(result.history.length, input.messages.length)
  }
})

test('official DeepSeek terminal delta role:null preserves the answer and final-chunk usage', async () => {
  // Exact terminal delta/usage shape in the API's streaming example, reviewed 2026-10-18:
  // https://api-docs.deepseek.com/api/create-chat-completion/
  const terminal = { choices: [{ delta: { content: '', role: null }, finish_reason: 'stop', index: 0, logprobs: null }],
    created: 1718345013, id: 'offline-official-shape', model: 'deepseek-flash', object: 'chat.completion.chunk', system_fingerprint: 'offline',
    usage: { completion_tokens: 9, prompt_tokens: 17, total_tokens: 26, prompt_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 17 } }
  const h = harness([sse(frame(chunk({ content: 'Hello!', role: 'assistant' })) + frame(terminal) + 'data: [DONE]\n\n')], { stream: true })
  const result = await h.provider.generate({ ...input, tools: [] }, signal())
  assert.equal(result.content, 'Hello!')
  assert.deepEqual(result.usage, { inputTokens: 17, outputTokens: 9, totalTokens: 26, cachedInputTokens: 0 })
})

test('an explicit stream error cannot masquerade as DONE after complete-looking tools', async () => {
  const complete = frame(chunk({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'read_state', arguments: '{"path":"a"}' } }] }, 'tool_calls'))
  for (const error of ['event: error\ndata: [DONE]\n\n', 'event: error\ndata: {"error":{"message":"failed"}}\n\n']) {
    const h = harness([sse(complete + error)], { stream: true })
    const result = await runAgent({ provider: h.provider, ...input, async executeTool() { assert.fail('Error frames must never authorize tool dispatch') } })
    assert.equal(result.status, 'error')
    assert.deepEqual(result.history, input.messages)
    assert.equal(result.rounds, 0)
  }
})

test('JSON rejects invalid arguments, identities, message shape, and incomplete finishes', async () => {
  const bad = [answer('', [call('id', 'read_state', '{bad')]), answer('', [call('id', 'read_state', '[]')]), answer('', [call('id', 'read_state', undefined)]),
    answer('', [call('has space')]), answer('text', [], {}), { choices: [] },
    { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [] } }] },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', tool_calls: [call()] } }] },
    { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'cut off' } }] },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ type: 'text', text: 'wrong native protocol' }] } }] }]
  // Undefined arguments are explicitly omitted; unlike OpenRouter, DeepSeek requires the field.
  delete bad[2].choices[0].message.tool_calls[0].function.arguments
  for (const value of bad) await assert.rejects(harness([value]).provider.generate(input, signal()), { code: 'invalid_response' })
})

test('cache hits are measured input, cache misses are not writes, and unknown usage is absent', async () => {
  for (const counts of [undefined, null, {}, { prompt_tokens: 3 }, { completion_tokens: 4 }]) {
    const result = await harness([answer('ok', [], 'think', counts)]).provider.generate(input, signal())
    assert.equal(Object.hasOwn(result, 'usage'), false)
  }
  for (const hits of [{ prompt_cache_hit_tokens: 7 }, { prompt_tokens_details: { cached_tokens: 7 } },
    { prompt_cache_hit_tokens: 7, prompt_tokens_details: { cached_tokens: 7 } }]) {
    const result = await harness([answer('ok', [], 'think', { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_cache_miss_tokens: 3, completion_tokens_details: { reasoning_tokens: 2 }, ...hits })]).provider.generate(input, signal())
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 7 })
    assert.equal(Object.hasOwn(result.usage, 'cacheWriteInputTokens'), false)
    assert.equal(JSON.stringify(result.providerState).includes('prompt_cache'), false)
  }
  const zero = await harness([answer('ok', [], '', { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 })]).provider.generate(input, signal())
  assert.deepEqual(zero.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0 })
  for (const bad of [{ prompt_cache_hit_tokens: -1 }, { prompt_cache_miss_tokens: 'bad' }, { completion_tokens_details: { reasoning_tokens: 5 } },
    { prompt_cache_hit_tokens: 11 }, { prompt_cache_miss_tokens: 11 }, { prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 3 },
    { prompt_cache_hit_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } }]) {
    await assert.rejects(harness([answer('ok', [], '', { prompt_tokens: 10, completion_tokens: 4, ...bad })]).provider.generate(input, signal()), { code: 'invalid_response' })
  }
})

test('context estimation uses the effective projection, no credentials, and no ignored no-tools reasoning', async () => {
  const prior = history('Earlier', 'native'.repeat(500))
  const h = harness([answer()])
  const seed = { messages: [...input.messages, prior], tools: [tool] }; const before = structuredClone(seed)
  const estimate = h.provider.estimateContext(seed, { maxOutputTokens: 1024 })
  assert.equal(h.credentials(), 0); assert.equal(h.requests.length, 0); assert.deepEqual(seed, before)
  await h.provider.generate(seed, signal(), { maxOutputTokens: 1024 })
  const body = h.requests[0].body
  const prompt = { messages: body.messages, tools: body.tools }
  const text = JSON.stringify(prompt); const ascii = [...text].filter(c => c.codePointAt(0) < 128).length
  const expected = Math.ceil(ascii / 3 + (new TextEncoder().encode(text).length - ascii) / 2) + 32 + body.messages.length * 8 + body.tools.length * 16
  assert.deepEqual(estimate, { inputTokens: expected, estimated: true })
  const reduced = structuredClone(seed); reduced.messages[1].providerState.items[0].reasoning_content = ''
  assert.ok(estimate.inputTokens > h.provider.estimateContext(reduced).inputTokens + 500)
  const plain = { messages: seed.messages.map(({ providerState, ...message }) => message), tools: [tool] }
  assert.throws(() => h.provider.estimateContext(plain), { code: 'configuration' })
  assert.deepEqual(h.provider.estimateContext({ ...seed, tools: [] }), h.provider.estimateContext({ ...plain, tools: [] }))
})

test('summary generation omits tools and ignored reasoning, respects output cap, and cannot commit calls', async () => {
  const seed = { messages: [...input.messages, history()], tools: [tool] }
  const h = harness([answer('Summary')])
  await h.provider.generate(seed, signal(), { purpose: 'context-summary', maxOutputTokens: 512 })
  assert.equal(h.requests[0].body.max_tokens, 512)
  assert.equal(Object.hasOwn(h.requests[0].body, 'tools'), false)
  assert.equal(Object.hasOwn(h.requests[0].body.messages[1], 'reasoning_content'), false)
  assert.equal(Object.hasOwn(h.requests[0].body, 'purpose'), false)
  await assert.rejects(harness([answer('', [call()])]).provider.generate(seed, signal(), { purpose: 'context-summary' }), { code: 'invalid_response' })
  for (const maxOutputTokens of [0, -1, 0.5, Infinity, NaN, null, '10']) {
    const invalid = harness()
    assert.throws(() => invalid.provider.estimateContext(input, { maxOutputTokens }), { code: 'configuration' })
    await assert.rejects(invalid.provider.generate(input, signal(), { maxOutputTokens }), { code: 'configuration' })
    assert.equal(invalid.requests.length, 0)
  }
})

test('structured context overflow is sanitized; generic HTTP errors never become overflow', async () => {
  for (const body of [{ error: { code: 'context_length_exceeded', message: privateValue } }, { error: { type: 'context_length_exceeded' } }]) {
    await assert.rejects(harness([new Response(JSON.stringify(body), { status: 400 })]).provider.generate(input, signal()), failure => {
      assert.equal(isContextOverflow(failure), true); assert.equal(failure.provider, 'DeepSeek'); assert.equal(failure.status, 400)
      assert.equal(JSON.stringify(failure).includes(privateValue), false); assert.equal(failure.message.includes(privateValue), false); return true
    })
  }
  for (const body of [privateValue, JSON.stringify({ error: { message: 'context_length_exceeded' } }), '{bad']) {
    await assert.rejects(harness([new Response(body, { status: 429 })]).provider.generate(input, signal()), { code: 'http', status: 429 })
  }
  await assert.rejects(harness([sse(frame({ error: { code: 'context_length_exceeded', message: privateValue } }))], { stream: true }).provider.generate(input, signal()), { code: 'context_overflow' })
})

test('cancellation and deadlines quarantine abort-ignoring fetch and credential resolution', async () => {
  for (const abort of [true, false]) {
    let fetches = 0
    const provider = createDeepSeekProvider({ model: 'deepseek-flash', apiKey: 'fake', timeoutMs: 30,
      fetch: async () => { fetches++; await new Promise(resolve => setTimeout(resolve, 100)); return new Response(JSON.stringify(answer())) } })
    const controller = new AbortController(); const pending = provider.generate(input, controller.signal)
    if (abort) setTimeout(() => controller.abort(), 5)
    await assert.rejects(pending, { code: abort ? 'aborted' : 'timeout', provider: 'DeepSeek' })
    assert.equal(fetches, 1)
  }
  const controller = new AbortController(); controller.abort()
  const h = harness(); await assert.rejects(h.provider.generate(input, controller.signal), { code: 'aborted' }); assert.equal(h.credentials(), 0)
  const resolver = createDeepSeekProvider({ apiKey: () => new Promise(() => {}), model: 'm', timeoutMs: 15, fetch: async () => assert.fail('No HTTP before credentials') })
  await assert.rejects(resolver.generate(input, signal()), { code: 'timeout' })
})

test('stream body cancellation and failed progress never commit partial assistant/tool state', async () => {
  let cancelled = 0
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frame(chunk({ content: 'partial' })))) }, cancel() { cancelled++ } })
  const h = harness([new Response(body, { headers: { 'content-type': 'text/event-stream' } })], { stream: true })
  const failure = new Error('host callback failure')
  await assert.rejects(h.provider.generate(input, signal(), { onProgress() { throw failure } }), error => error === failure)
  assert.equal(cancelled, 1)
})
