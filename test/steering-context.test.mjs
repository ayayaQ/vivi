// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test as nodeTest } from 'node:test'
import { runAgent, estimateContext } from '../dist/index.js'
import { createDeepSeekProvider } from '../dist/providers/deepseek.js'

const test = (name, fn) => nodeTest(name, { timeout: 3_000 }, fn)
const user = (content) => ({ kind: 'message', role: 'user', content })
const answer = (content) => ({ content, toolCalls: [] })
const history = () => [...Array.from({ length: 10 }, (_, i) => [user(`old ${i} ${'a'.repeat(200)}`),
  { kind: 'assistant', ...answer(`answer ${i} ${'b'.repeat(200)}`) }]).flat(), user('current request')]
const noTools = async () => { throw Error('No tool expected') }

test('steering is included in the next prepared context without rewriting canonical history', async () => {
  const initial = [user('initial')], updates = [], requests = []
  let pulls = 0
  const result = await runAgent({ messages: initial, tools: [], executeTool: noTools,
    context: { sourceId: 'steering-context', limits: { contextWindow: 12000, maxOutputTokens: 100 },
      prefixMessages: [user('host memory')] },
    provider: { estimateContext, async generate(request, _signal, options) {
      requests.push(request); assert.equal(options.maxOutputTokens, 100)
      return answer(`round ${requests.length}`)
    } }, getSteeringMessages() { return ++pulls === 1 ? [user('steer')] : [] },
    onAccepted(update) { updates.push(update) } })
  assert.equal(result.status, 'completed'); assert.equal(result.rounds, 2)
  assert.equal(requests[1].messages.at(-1).content, 'steer')
  assert.equal(requests[1].messages[0].content, 'host memory')
  assert.deepEqual(result.history.map(message => message.content), ['initial', 'round 1', 'steer', 'round 2'])
  assert.deepEqual(updates.map(update => update.type), ['assistant_accepted', 'user_message_accepted', 'assistant_accepted'])
  assert.equal(result.contextUsage.estimated, true)
})

test('overflow after steering retries only generation and retains exact admitted input and tool result', async () => {
  const initial = history(), requests = [], updates = []
  let pulls = 0, summaries = 0, executions = 0
  const result = await runAgent({ messages: initial,
    tools: [{ name: 'work', description: 'Offline fixture', parameters: {} }],
    context: { sourceId: 'steering-overflow', keepRecentMessages: 3 },
    provider: { estimateContext, async generate(request, _signal, options) {
      if (options.purpose === 'context-summary') { summaries++; return answer('concise prior context') }
      requests.push(request)
      if (requests.length === 1) return { content: 'work', toolCalls: [{ id: 'one', name: 'work', arguments: {} }] }
      if (requests.length === 2) throw Object.assign(new Error('fixture overflow'), { code: 'context_overflow' })
      return answer('done')
    } }, async executeTool() { executions++; return { content: 'completed effect' } },
    getSteeringMessages() { return ++pulls === 1 ? [user('new exact goal')] : [] },
    onAccepted(update) { updates.push(update) } })
  assert.equal(result.status, 'completed'); assert.equal(result.rounds, 2)
  assert.equal(executions, 1); assert.equal(summaries, 1); assert.equal(requests.length, 3); assert.equal(pulls, 2)
  assert(requests[2].messages.length < requests[1].messages.length)
  for (const request of requests.slice(1)) assert.equal(request.messages.at(-1).content, 'new exact goal')
  assert.deepEqual(result.history.slice(0, initial.length), initial)
  assert.equal(result.history.filter(message => message.content === 'new exact goal').length, 1)
  assert.equal(result.history.filter(message => message.kind === 'tool_result').length, 1)
  assert.equal(updates.filter(update => update.type === 'user_message_accepted').length, 1)
  assert(result.checkpoint)
})

test('context preparation failure after admission retains queued user for host reconciliation', async () => {
  let pulls = 0, calls = 0
  const queued = user('larger queued request '.repeat(60))
  const result = await runAgent({ messages: [user('initial')], tools: [], executeTool: noTools,
    context: { sourceId: 'steering-fit', limits: { contextWindow: 500, maxOutputTokens: 100 }, autoCompact: false },
    provider: { estimateContext, async generate() { calls++; return answer('first') } },
    getSteeringMessages() { pulls++; return [queued] } })
  assert.equal(result.status, 'error'); assert.equal(result.error.code, 'context_cannot_fit')
  assert.equal(calls, 1); assert.equal(pulls, 1); assert.equal(result.rounds, 1)
  assert.deepEqual(result.history.at(-1), queued)
})

test('DeepSeek context output cap and native reasoning survive a steered next round', async () => {
  const bodies = []; let pulls = 0
  const provider = createDeepSeekProvider({ apiKey: 'offline', model: 'deepseek-flash',
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        role: 'assistant', content: `round ${bodies.length}`, reasoning_content: 'retained reasoning'
      } }] }))
    } })
  const result = await runAgent({ messages: [user('initial')], tools: [], executeTool: noTools, provider,
    context: { sourceId: 'deepseek-steering', limits: { contextWindow: 12000, maxOutputTokens: 100 } },
    getSteeringMessages() { return ++pulls === 1 ? [user('steer')] : [] } })
  assert.equal(result.status, 'completed'); assert.equal(bodies.length, 2)
  assert(bodies.every(body => body.max_tokens === 100))
  assert.equal(bodies[1].messages.at(-1).content, 'steer')
  assert.equal(result.history[1].providerState.provider, 'deepseek:deepseek-flash')
  assert.equal(result.history[1].providerState.items[0].reasoning_content, 'retained reasoning')
})
