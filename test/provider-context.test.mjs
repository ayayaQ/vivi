// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test as nodeTest } from 'node:test'
import { createOpenAIProvider, isContextOverflow as openAiOverflow } from '../dist/providers/openai.js'
import { createOpenRouterProvider, isContextOverflow as routerOverflow } from '../dist/providers/openrouter.js'
import { normalizeModelCapabilities } from '../dist/providers/models.js'

const test = (name, fn) => nodeTest(name, { timeout: 3_000 }, fn)
const signal = () => new AbortController().signal
const seed = { messages: [{ kind: 'message', role: 'user', content: 'Inspect the current state carefully' }], tools: [] }
const privateValue = 'private-credential-url-and-upstream-detail'
const frame = (value, event = '') => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(value)}\n\n`
const sse = (text) => new Response(text, { headers: { 'content-type': 'text/event-stream' } })
const completed = (kind, usage) => kind === 'openai'
  ? { status: 'completed', output: [], ...(usage !== undefined ? { usage } : {}) }
  : { choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }], ...(usage !== undefined ? { usage } : {}) }
function harness(kind, response, options = {}) {
  const requests = []
  let credentials = 0
  const factory = kind === 'openai' ? createOpenAIProvider : createOpenRouterProvider
  const provider = factory({ model: `fixture-${kind}`, apiKey() { credentials++; return privateValue },
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body))
      assert.equal(requests.length, 1, 'Provider must not retry')
      return response instanceof Response ? response : new Response(JSON.stringify(response ?? completed(kind)))
    }, ...options })
  return { provider, requests, credentials: () => credentials }
}
// Independently compute the documented heuristic from the actual final wire projection.
function expectedEstimate(body) {
  const prompt = Object.fromEntries(['input', 'messages', 'tools', 'tool_choice', 'reasoning']
    .filter((key) => body[key] !== undefined).map((key) => [key, body[key]]))
  const serialized = JSON.stringify(prompt)
  const ascii = [...serialized].filter((char) => char.codePointAt(0) < 128).length
  const bytes = new TextEncoder().encode(serialized).length
  return { inputTokens: Math.ceil(ascii / 3 + (bytes - ascii) / 2) + 32 +
    (body.input ?? body.messages).length * 8 + (body.tools?.length ?? 0) * 16, estimated: true }
}
const tool = { name: 'read_state', description: 'Read state', parameters: {
  type: 'object', properties: { path: { type: 'string', description: 'Path to inspect' } }, required: ['path']
} }
function nativeHistory(kind, model, retained) {
  return [{ kind: 'assistant', content: 'Inspecting', toolCalls: [], providerState: {
    provider: `${kind}:${model}`, items: kind === 'openai' ? [
      { type: 'reasoning', id: 'reasoning-1', summary: [], encrypted_content: retained },
      { type: 'message', id: 'message-1', role: 'assistant', content: [{ type: 'output_text', text: 'Inspecting', annotations: [] }] }
    ] : [{ role: 'assistant', content: 'Inspecting', reasoning_details: [{ type: 'reasoning.encrypted', data: retained }] }]
  } }]
}
for (const kind of ['openai', 'openrouter']) {
  test(`${kind} context estimate shares complete native/schema projection with generation`, async () => {
    const h = harness(kind, undefined, { reasoning: { mode: 'effort', effort: 'high' }, supportedReasoningEfforts: ['high'] })
    const input = { messages: [...seed.messages, ...nativeHistory(kind, `fixture-${kind}`, 'opaque'.repeat(200))], tools: [tool] }
    const before = structuredClone(input)
    const estimate = h.provider.estimateContext(input, { maxOutputTokens: 512 })
    assert.deepEqual(input, before)
    assert.equal(h.credentials(), 0)
    assert.equal(h.requests.length, 0)
    assert.equal(estimate.estimated, true)
    await h.provider.generate(input, signal(), { maxOutputTokens: 512, purpose: 'context-summary' })
    assert.deepEqual(estimate, expectedEstimate(h.requests[0]))
    assert.equal(h.requests[0][kind === 'openai' ? 'max_output_tokens' : 'max_tokens'], 512)
    assert.equal(Object.hasOwn(h.requests[0], 'purpose'), false)
    const plain = { messages: input.messages.map(({ providerState, ...message }) => message), tools: [tool] }
    assert.ok(estimate.inputTokens > h.provider.estimateContext(plain).inputTokens + 300)
    const mismatch = structuredClone(input)
    mismatch.messages.at(-1).providerState.provider = `${kind}:different-model`
    assert.deepEqual(h.provider.estimateContext(mismatch), h.provider.estimateContext(plain))
  })
  test(`${kind} multilingual/code/schema estimates are honest and include newly added schema bytes`, () => {
    const h = harness(kind)
    const estimate = (content, tools = []) => h.provider.estimateContext({ messages: [{ ...seed.messages[0], content }], tools })
    const latin = estimate('a'.repeat(400))
    const cjk = estimate('你好世界'.repeat(100))
    assert.ok(cjk.inputTokens > latin.inputTokens * 2)
    assert.ok(cjk.inputTokens >= 600)
    const code = estimate('const input = { state: [1, 2, 3] };\n'.repeat(30))
    assert.ok(code.inputTokens > latin.inputTokens)
    const largeTool = { ...tool, parameters: { ...tool.parameters, description: '字段说明'.repeat(300) } }
    assert.ok(estimate('', [largeTool]).inputTokens > estimate('', [tool]).inputTokens + 1_500)
    for (const value of [latin, cjk, code]) {
      assert.equal(value.estimated, true)
      assert.ok(Number.isSafeInteger(value.inputTokens) && value.inputTokens > 0)
    }
    assert.equal(h.credentials(), 0)
  })
  test(`${kind} credentials, selectors, transport/routing fields and output bounds do not inflate input occupancy`, () => {
    const baseline = harness(kind).provider.estimateContext(seed)
    const other = harness(kind, undefined, { apiKey: privateValue.repeat(10_000), model: 'a-very-different-model',
      baseURL: 'https://example.test/longer/api/root', stream: true,
      ...(kind === 'openrouter' ? { requireSupportedParameters: true, attribution: { title: privateValue.repeat(100) } } : {}) })
    assert.deepEqual(other.provider.estimateContext(seed, { maxOutputTokens: 99_999 }), baseline)
    assert.deepEqual(other.provider.estimateContext(seed), baseline)
  })
  test(`${kind} validates explicit output bounds and leaves absent bounds omitted`, async () => {
    for (const maxOutputTokens of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10', null]) {
      const h = harness(kind)
      assert.throws(() => h.provider.estimateContext(seed, { maxOutputTokens }), { code: 'configuration' })
      await assert.rejects(h.provider.generate(seed, signal(), { maxOutputTokens }), { code: 'configuration' })
      assert.equal(h.requests.length, 0)
    }
    const h = harness(kind)
    await h.provider.generate(seed, signal())
    assert.equal(Object.hasOwn(h.requests[0], 'max_tokens'), false)
    assert.equal(Object.hasOwn(h.requests[0], 'max_output_tokens'), false)
  })
  test(`${kind} recognizes bounded structured HTTP overflow codes without retaining private data`, async () => {
    for (const error of [{ code: 'context_length_exceeded' }, { type: 'context_length_exceeded' },
      { metadata: { error_type: 'context_length_exceeded', raw: privateValue } }]) {
      const h = harness(kind, new Response(JSON.stringify({ error: { ...error, message: privateValue } }), { status: 400 }))
      await assert.rejects(h.provider.generate(seed, signal()), (failure) => {
        assert.equal(failure.code, 'context_overflow')
        assert.equal(failure.status, 400)
        assert.equal(openAiOverflow(failure), true)
        assert.equal(routerOverflow(failure), true)
        assert.equal(failure.cause, undefined)
        assert.equal(JSON.stringify(failure).includes(privateValue), false)
        assert.equal(failure.message.includes(privateValue), false)
        return true
      })
      assert.equal(h.requests.length, 1)
    }
  })
  test(`${kind} generic token/auth/malformed/oversize errors never masquerade as context overflow`, async () => {
    const bodies = [
      ...['max_tokens_exceeded', 'token_limit_exceeded', 'string_too_long', 'invalid_request_error', 'authentication']
        .map((code) => JSON.stringify({ error: { code, message: 'maximum context length exceeded context_length_exceeded' } })),
      JSON.stringify({ error: { message: 'context_length_exceeded', metadata: { raw: JSON.stringify({ code: 'context_length_exceeded' }) } } }),
      '{"error":{"code":"context_length_exceeded"',
      JSON.stringify({ error: { code: 'context_length_exceeded', message: 'x'.repeat(65_536) } })
    ]
    for (const body of bodies) {
      const h = harness(kind, new Response(body, { status: 400 }))
      await assert.rejects(h.provider.generate(seed, signal()), (failure) => failure.code === 'http' && !openAiOverflow(failure))
    }
    const h = harness(kind, new Response('', { status: 413 }))
    await assert.rejects(h.provider.generate(seed, signal()), { code: 'http' })
  })
  test(`${kind} bounded error-body reads respect cancellation and end-to-end deadlines`, async () => {
    for (const cancel of [true, false]) {
      let cancelled = 0
      const h = harness(kind, new Response(new ReadableStream({ cancel() { cancelled++ } }), { status: 400 }), { timeoutMs: 20 })
      const controller = new AbortController()
      const pending = h.provider.generate(seed, controller.signal)
      if (cancel) setTimeout(() => controller.abort(), 1)
      await assert.rejects(pending, { code: cancel ? 'aborted' : 'timeout' })
      assert.equal(cancelled, 1)
    }
  })
  test(`${kind} missing or partial usage stays absent while complete explicit zeros remain measured`, async () => {
    const inputKey = kind === 'openai' ? 'input_tokens' : 'prompt_tokens'
    const outputKey = kind === 'openai' ? 'output_tokens' : 'completion_tokens'
    for (const value of [undefined, null, {}, { [inputKey]: 1 }, { [outputKey]: 1 }, { total_tokens: 7 },
      { [inputKey]: null, [outputKey]: 0 }]) {
      const result = await harness(kind, completed(kind, value)).provider.generate(seed, signal())
      assert.equal(result.usage, undefined)
      assert.equal(Object.hasOwn(result, 'usage'), false)
    }
    const result = await harness(kind, completed(kind, { [inputKey]: 0, [outputKey]: 0 })).provider.generate(seed, signal())
    assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    await assert.rejects(harness(kind, completed(kind, { [inputKey]: 'private-invalid-count' })).provider.generate(seed, signal()), { code: 'invalid_response' })
  })
  test(`${kind} successful JSON envelopes still reject machine-readable context errors`, async () => {
    const value = kind === 'openai'
      ? { status: 'failed', error: { code: 'context_length_exceeded', message: privateValue } }
      : { error: { metadata: { error_type: 'context_length_exceeded' }, message: privateValue } }
    await assert.rejects(harness(kind, value).provider.generate(seed, signal()), { code: 'context_overflow' })
    if (kind === 'openrouter') await assert.rejects(harness(kind, {
      choices: [{ error: { type: 'context_length_exceeded' }, finish_reason: 'error' }]
    }).provider.generate(seed, signal()), { code: 'context_overflow' })
  })
  test(`${kind} streamed overflow is classified before accepting tools or completion`, async () => {
    const error = { code: 'context_length_exceeded', message: privateValue }
    const frames = kind === 'openai' ? [
      frame({ type: 'response.failed', response: { error } }),
      frame({ type: 'response.incomplete', response: { error } }),
      frame({ type: 'error', error }), frame(error, 'error')
    ] : [frame({ error }), frame({ error: { metadata: { error_type: 'context_length_exceeded' } } }, 'error'),
      frame({ choices: [{ index: 0, error, finish_reason: 'error', delta: {} }] })]
    for (const text of frames) {
      const h = harness(kind, sse(text), { stream: true })
      await assert.rejects(h.provider.generate(seed, signal()), (failure) => failure.code === 'context_overflow' && !failure.message.includes(privateValue))
    }
  })
}

test('overflow helper checks only a stable structured error code, without invoking getters', () => {
  const error = Object.assign(new Error('fixture'), { code: 'context_overflow' })
  assert.equal(openAiOverflow(error), true)
  for (const value of [null, {}, { code: 'context_overflow' }, new Error('context_overflow')]) assert.equal(openAiOverflow(value), false)
  const getter = Object.defineProperty(new Error('fixture'), 'code', { get() { assert.fail('Do not invoke code accessor') } })
  assert.equal(openAiOverflow(getter), false)
})

const capabilities = (model, provider = 'openrouter', protocol = 'chat-completions') =>
  normalizeModelCapabilities({ apiVersion: 1, provider, protocol, model })
test('OpenRouter separates catalog total window, top-provider output and explicit endpoint input cap', () => {
  const value = capabilities({ id: 'vendor/model', context_length: 100_000, max_prompt_tokens: 70_000,
    top_provider: { context_length: 90_000, max_completion_tokens: 20_000 } })
  assert.equal(value.contextWindow, 100_000)
  assert.equal(value.maxInputTokens, 70_000)
  assert.equal(value.maxOutputTokens, 20_000)
  assert.equal(value.contextLimitsSource.kind, 'provider-catalog')
  assert.equal(Object.isFrozen(value.contextLimitsSource), true)
  const catalog = capabilities({ id: 'vendor/model', context_length: 100_000, top_provider: { max_completion_tokens: 20_000 } })
  assert.equal(catalog.maxInputTokens, undefined)
  assert.equal(catalog.contextWindow, 100_000)
  const inputOnly = capabilities({ id: 'vendor/model', max_prompt_tokens: 70_000 })
  assert.equal(inputOnly.contextWindow, undefined)
  assert.equal(inputOnly.maxInputTokens, 70_000)
  const undocumented = capabilities({ id: 'vendor/model', top_provider: { max_prompt_tokens: 70_000, context_length: 90_000 } })
  assert.equal(undocumented.maxInputTokens, undefined)
  assert.equal(undocumented.contextWindow, undefined)
})
test('malformed, null, contradictory, inaccessible and wrong-protocol limits remain unknown', () => {
  for (const limit of [undefined, null, 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100', {}, []]) {
    const value = capabilities({ id: 'vendor/model', context_length: limit, max_prompt_tokens: limit, top_provider: { max_completion_tokens: limit } })
    for (const key of ['contextWindow', 'maxInputTokens', 'maxOutputTokens', 'contextLimitsSource']) assert.equal(Object.hasOwn(value, key), false)
  }
  const contradictory = capabilities({ id: 'vendor/model', context_length: 10, max_prompt_tokens: 11, top_provider: { max_completion_tokens: 12 } })
  assert.equal(contradictory.contextWindow, 10)
  assert.equal(contradictory.maxInputTokens, undefined)
  assert.equal(contradictory.maxOutputTokens, undefined)
  const getter = Object.defineProperties({ id: 'vendor/model' }, Object.fromEntries(['context_length', 'max_prompt_tokens', 'top_provider']
    .map((key) => [key, { get() { assert.fail('Do not execute catalog accessor') } }])))
  assert.equal(capabilities(getter).contextWindow, undefined)
  assert.equal(capabilities({ id: 'vendor/model', context_length: 100 }, 'openrouter', 'responses').contextWindow, undefined)
})
test('OpenAI context metadata uses verified exact IDs only and never accepts unrelated catalog capacities', () => {
  for (const [ids, contextWindow, maxOutputTokens] of [
    [['gpt-5', 'gpt-5-2025-08-07', 'gpt-5.1', 'gpt-5.1-2025-11-13', 'gpt-5.4-nano', 'gpt-5.4-nano-2026-03-17'], 400_000, 128_000],
    [['gpt-4.1', 'gpt-4.1-2025-04-14'], 1_047_576, 32_768],
    [['gpt-5-pro', 'gpt-5-pro-2025-10-06'], 400_000, 272_000],
    [['o3-pro', 'o3-pro-2025-06-10'], 200_000, 100_000]
  ]) for (const id of ids) {
    const value = capabilities({ id, context_length: 999, max_prompt_tokens: 12 }, 'openai', 'responses')
    assert.equal(value.contextWindow, contextWindow)
    assert.equal(value.maxOutputTokens, maxOutputTokens)
    assert.equal(value.maxInputTokens, undefined)
    assert.equal(value.contextLimitsSource.kind, 'official-model-documentation')
    assert.equal(value.contextLimitsSource.reviewedOn, '2026-10-15')
  }
  for (const id of ['gpt-5-next', 'gpt-5-2099-01-01', 'GPT-5', 'openai/gpt-5', 'ft:gpt-5:fixture', 'unknown', 'text-embedding-3-small']) {
    const value = capabilities({ id, context_length: 999_999, max_prompt_tokens: 999_000 }, 'openai', 'responses')
    for (const key of ['contextWindow', 'maxInputTokens', 'maxOutputTokens', 'contextLimitsSource']) assert.equal(Object.hasOwn(value, key), false)
  }
  assert.equal(capabilities({ id: 'gpt-5-pro' }, 'openai', 'chat-completions').contextWindow, undefined)
})

test('reserved canonical call IDs never enter wire prompts and do not rewrite native reasoning identities', async () => {
  for (const kind of ['openai', 'openrouter']) {
    const response = kind === 'openai' ? { status: 'completed', output: [
      { type: 'function_call', call_id: 'old-call', name: 'read_state', arguments: '{}' }
    ] } : { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', reasoning_content: 'native reasoning',
      tool_calls: [{ id: 'old-call', type: 'function', function: { name: 'read_state', arguments: '{}' } }] } }] }
    const h = harness(kind, response)
    await assert.rejects(() => h.provider.generate(seed, signal(), { reservedToolCallIds: ['old-call'] }), /tool call ID was reused/)
    assert.equal(JSON.stringify(h.requests[0]).includes('old-call'), false)
  }
  const h = harness('openrouter')
  const invalid = []; Object.defineProperty(invalid, '0', { enumerable: true, get() { throw Error('must not invoke') } })
  assert.throws(() => h.provider.generate(seed, signal(), { reservedToolCallIds: invalid }), /reservedToolCallIds/)
  assert.equal(h.requests.length, 0)
})
