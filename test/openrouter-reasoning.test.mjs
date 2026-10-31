// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test as nodeTest } from 'node:test'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { runAgent } from '../dist/index.js'
import { createOpenRouterProvider } from '../dist/providers/openrouter.js'
import { normalizeModelCapabilities } from '../dist/providers/models.js'
import { estimateRequestContext } from '../dist/providers/transport.js'
import { assertCanonicalHistory } from '../dist/validation.js'

const test = (name, fn) => nodeTest(name, { timeout: 3000 }, fn)
const model = 'anthropic/claude-haiku-5.5'
const bindingKey = '_vivi_openrouter_reasoning'
const signal = () => new AbortController().signal
const tools = [{ name: 'read_skill', description: 'Read a skill', parameters: { type: 'object' } }]
const seed = [
  { kind: 'message', role: 'system', content: 'Host instructions' },
  { kind: 'message', role: 'user', content: 'Available skills: creator' },
  { kind: 'message', role: 'user', content: 'Create a useful skill' }
]
const native = (id = 'call_1') => ({
  role: 'assistant', content: '', reasoning: `Think about ${id}`,
  reasoning_details: [
    { type: 'reasoning.text', format: 'anthropic-claude-v1', text: `Think about ${id}`, signature: `opaque-${id}` },
    { type: 'reasoning.encrypted', data: `encrypted-${id}` }
  ],
  tool_calls: [{ id, type: 'function', function: { name: 'read_skill', arguments: '{ }' } }]
})
const assistant = (reply) => ({ kind: 'assistant', content: reply.content,
  toolCalls: reply.toolCalls, providerState: reply.providerState })
const receipt = (id = 'call_1', content = 'Skill instructions') => ({
  kind: 'tool_result', callId: id, name: 'read_skill', content
})
const continued = (reply, history = seed, id = 'call_1') => [...history, assistant(reply), receipt(id)]

function harness({ stream = false, replies = [native(), { role: 'assistant', content: 'Done' }],
  factory = createOpenRouterProvider, ...options } = {}) {
  const requests = []
  const queue = [...replies]
  const fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    assert.ok(queue.length, 'No live network fallback')
    const message = queue.shift()
    const finish_reason = message.tool_calls?.length ? 'tool_calls' : 'stop'
    if (!stream) return new Response(JSON.stringify({ choices: [{ message, finish_reason }] }))
    const delta = { ...message, ...(message.tool_calls ? {
      tool_calls: message.tool_calls.map((call, index) => ({ index, ...call }))
    } : {}) }
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\ndata: [DONE]\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' }
    })
  }
  const provider = factory({ model, apiKey: 'offline-fixture-key', stream, fetch, ...options })
  return { provider, requests, fetch,
    run: (messages = seed, selectedTools = tools, generateOptions) =>
      provider.generate({ messages, tools: selectedTools }, signal(), generateOptions) }
}

for (const stream of [false, true]) {
  test(`Claude reasoning survives JSON persistence and a fresh provider (stream=${stream})`, async () => {
    const h = harness({ stream })
    const reply = await h.run()
    const binding = reply.providerState.items[0][bindingKey]
    assert.deepEqual(Object.keys(binding).sort(), ['assistant', 'prefix', 'version'])
    assert.equal(binding.version, 1)
    assert.match(binding.prefix, /^[a-f0-9]{64}$/)
    assert.match(binding.assistant, /^[a-f0-9]{64}$/)
    assert.equal(JSON.stringify(binding).includes('Host instructions'), false)
    const history = JSON.parse(JSON.stringify(continued(reply)))
    assertCanonicalHistory(history)
    const original = structuredClone(history)
    const resumed = createOpenRouterProvider({ model, apiKey: 'different-account-key', stream, fetch: h.fetch })
    await resumed.generate({ messages: history, tools }, signal())
    assert.deepEqual(h.requests[1].messages.at(-2), native())
    assert.equal(JSON.stringify(h.requests[1]).includes(bindingKey), false)
    assert.deepEqual(history, original)
  })
}

for (const changed of ['system', 'catalog', 'message', 'compaction', 'tools', 'schema']) {
  test(`Claude omits stale reasoning after a ${changed} change, preserving native calls`, async () => {
    const h = harness()
    const history = continued(await h.run())
    let selectedTools = tools
    if (changed === 'system') history[0].content = 'New host instructions'
    if (changed === 'catalog') history[1].content = 'Available skills: creator, designer'
    if (changed === 'message') history[2].content = 'An edited earlier request'
    if (changed === 'compaction') history.splice(0, 3, { kind: 'message', role: 'user', content: 'Portable summary' })
    if (changed === 'tools') selectedTools = []
    if (changed === 'schema') selectedTools = [{ ...tools[0], parameters: { type: 'object', properties: { name: { type: 'string' } } } }]
    const original = structuredClone(history)
    await h.run(history, selectedTools)
    const { reasoning, reasoning_details, ...expected } = native()
    assert.deepEqual(h.requests[1].messages.at(-2), expected)
    assert.deepEqual(h.requests[1].messages.at(-1), { role: 'tool', tool_call_id: 'call_1', content: 'Skill instructions' })
    assert.deepEqual(history, original)
    assert.equal(h.requests.length, 2)
  })
}

test('changing reasoning settings also invalidates a persisted binding', async () => {
  const h = harness()
  const history = continued(await h.run())
  const resumed = createOpenRouterProvider({ model, apiKey: 'offline-fixture-key', fetch: h.fetch,
    reasoning: { mode: 'effort', effort: 'high' }, supportedReasoningEfforts: ['high'] })
  await resumed.generate({ messages: history, tools }, signal())
  assert.equal(h.requests[1].messages.at(-2).reasoning_details, undefined)
  assert.deepEqual(h.requests[1].reasoning, { effort: 'high', exclude: false })
})

test('an expired skill receipt invalidates all later reasoning, then fresh reasoning remains usable', async () => {
  const h = harness({ replies: [native(), native('call_2'), native('call_3'), { role: 'assistant', content: 'Done' }] })
  let history = continued(await h.run())
  history = continued(await h.run(history), history, 'call_2')
  history[4] = receipt('call_1', 'Earlier skill guidance omitted; read it again')
  const third = await h.run(history)
  const assistants = h.requests[2].messages.filter(message => message.role === 'assistant')
  assert.deepEqual(assistants[0].reasoning_details, native().reasoning_details)
  assert.equal(assistants[1].reasoning_details, undefined)
  history = continued(third, history, 'call_3')
  await h.run(history)
  assert.deepEqual(h.requests[3].messages.at(-2).reasoning_details, native('call_3').reasoning_details)
})

for (const changed of ['legacy', 'text', 'signature', 'binding']) {
  test(`unverifiable ${changed} reasoning is omitted without modifying stored evidence`, async () => {
    const h = harness()
    const history = continued(await h.run())
    const item = history[3].providerState.items[0]
    if (changed === 'legacy') delete item[bindingKey]
    if (changed === 'text') item.reasoning_details[0].text += ' edited'
    if (changed === 'signature') item.reasoning_details[0].signature += '-edited'
    if (changed === 'binding') item[bindingKey] = { version: 2, prefix: 'unrecognized' }
    const original = structuredClone(history)
    await h.run(history)
    assert.equal(h.requests[1].messages.at(-2).reasoning_details, undefined)
    assert.deepEqual(history, original)
  })
}

test('estimation and dispatch agree for unchanged and expired native reasoning', async () => {
  for (const changed of [false, true]) {
    const h = harness()
    const history = continued(await h.run())
    if (changed) history[1].content += ', newly saved skill'
    const input = { messages: history, tools }
    const before = structuredClone(input)
    const estimate = h.provider.estimateContext(input)
    await h.run(history)
    assert.deepEqual(estimate, estimateRequestContext(h.requests[1]))
    assert.deepEqual(input, before)
  }
})

test('the binding captures the dispatched snapshot even if callers mutate input during HTTP', async () => {
  const input = { messages: structuredClone(seed), tools: structuredClone(tools) }
  const h = harness()
  const provider = createOpenRouterProvider({ model, apiKey: 'offline-fixture-key', fetch: async (...args) => {
    input.messages[0].content = 'Changed while HTTP is pending'
    input.tools[0].description = 'Changed schema'
    return h.fetch(...args)
  } })
  const reply = await provider.generate(input, signal())
  await h.run(continued(reply))
  assert.deepEqual(h.requests[1].messages.at(-2).reasoning_details, native().reasoning_details)
})

test('non-Claude OpenRouter reasoning retains its existing exact replay behavior', async () => {
  const h = harness({ model: 'google/gemini-fixture' })
  const reply = await h.run()
  assert.equal(reply.providerState.items[0][bindingKey], undefined)
  const history = continued(reply)
  history[0].content = 'A different prefix'
  await h.run(history)
  assert.deepEqual(h.requests[1].messages.at(-2), native())
})

test('CommonJS provider instances also retain persisted bindings', async () => {
  const require = createRequire(import.meta.url)
  const factory = require('../dist/cjs/providers/openrouter.js').createOpenRouterProvider
  const h = harness({ factory })
  const history = continued(await h.run())
  await factory({ model, apiKey: 'offline-fixture-key', fetch: h.fetch }).generate({ messages: history, tools }, signal())
  assert.deepEqual(h.requests[1].messages.at(-2), native())
})

test('the real agent loop continues after a refreshed skill prefix without re-executing old calls', async () => {
  const h = harness({ replies: [native(), { role: 'assistant', content: 'Saved skill' },
    native('call_2'), { role: 'assistant', content: 'Used the new skill' }] })
  const executed = []
  const options = { provider: h.provider, tools, executeTool: async (call) => {
    executed.push(call.id)
    return { content: 'Skill tool receipt' }
  } }
  const first = await runAgent({ ...options, messages: [seed[2]],
    context: { sourceId: 'skill-refresh-fixture', prefixMessages: seed.slice(0, 2) } })
  assert.equal(first.status, 'completed')
  const stored = JSON.parse(JSON.stringify(first.history))
  const second = await runAgent({ ...options,
    messages: [...stored, { kind: 'message', role: 'user', content: 'Use the newly saved skill' }],
    context: { sourceId: 'skill-refresh-fixture', prefixMessages: [seed[0],
      { ...seed[1], content: 'Available skills: creator, newly saved skill' }] } })
  assert.equal(second.status, 'completed')
  assert.deepEqual(executed, ['call_1', 'call_2'])
  assert.equal(h.requests[2].messages.find(message => message.role === 'assistant').reasoning_details, undefined)
  assert.deepEqual(h.requests[3].messages.at(-2).reasoning_details, native('call_2').reasoning_details)
  assert.deepEqual(second.history.slice(0, stored.length), stored)
  assertCanonicalHistory(second.history)
})

test('image references produce the same replay decision in estimates without resolving pixels', async () => {
  const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
  const image = { id: 'snapshot', sha256: createHash('sha256').update(pixels).digest('hex'),
    mimeType: 'image/png', width: 1, height: 1, byteLength: pixels.length }
  let resolutions = 0
  const modelCapabilities = normalizeModelCapabilities({ apiVersion: 1, provider: 'openrouter',
    protocol: 'chat-completions', model: { id: model, supported_parameters: ['tools'],
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } } })
  const h = harness({ replies: [native(), native('call_2'), { role: 'assistant', content: 'Done' }],
    modelCapabilities, resolveImage() { resolutions++; return pixels } })
  let history = continued(await h.run())
  history.at(-1).images = [image]
  history = continued(await h.run(history), history, 'call_2')
  const before = resolutions
  const original = structuredClone(history)
  h.provider.estimateContext({ messages: history, tools })
  assert.equal(resolutions, before)
  await h.run(history)
  assert.equal(resolutions, before + 1)
  assert.deepEqual(h.requests[2].messages.at(-2).reasoning_details, native('call_2').reasoning_details)
  assert.deepEqual(history, original)
})
