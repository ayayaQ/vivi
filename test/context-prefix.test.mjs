// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { test } from 'node:test'
import { runAgent, estimateContext } from '../dist/index.js'
const message = (content, role = 'user') => ({ kind: 'message', role, content })
const answer = content => ({ content, toolCalls: [] })
const tool = { name: 'read', description: 'Offline fixture', parameters: {} }
const call = { id: 'one', name: 'read', arguments: {} }
const options = extra => ({ messages: [message('goal')], tools: [], executeTool: async () => { throw Error('Unexpected tool') },
  provider: { async generate() { return answer('done') } }, ...extra })

test('fresh context prefix is detached per dispatch and absent from canonical updates/history', async () => {
  const requests = [], updates = [], order = []
  let revision = 1
  const offered = [message('host framing', 'system'), message('project data revision 1')]
  const result = await runAgent(options({ tools: [tool],
    getContextPrefix({ signal }) { assert.equal(signal.aborted, false); order.push(`prefix ${revision}`); return offered },
    provider: { async generate(input) { requests.push(input); order.push(`dispatch ${requests.length}`)
      return requests.length === 1 ? { content: '', toolCalls: [call] } : answer('done') } },
    async executeTool() { revision++; offered[1].content = 'project data revision 2'; return { content: 'read' } },
    onAccepted(update) { updates.push(update) } }))
  assert.equal(result.status, 'completed')
  assert.deepEqual(order, ['prefix 1', 'dispatch 1', 'prefix 2', 'dispatch 2'])
  assert.equal(requests[0].messages[1].content, 'project data revision 1')
  assert.equal(requests[1].messages[1].content, 'project data revision 2')
  assert.equal(result.history[0].content, 'goal')
  assert.equal(result.history.length, 4)
  assert.equal(updates.some(update => update.type === 'user_message_accepted'), false)
  assert.equal(result.history.some(item => item.content.includes('project data')), false)
})

test('prefix joins static context before measurement and is not checkpointed or summary source', async () => {
  const old = Array.from({ length: 8 }, (_, index) => [message(`old ${index} ${'x'.repeat(300)}`),
    { kind: 'assistant', content: 'y'.repeat(300), toolCalls: [] }]).flat()
  const requests = [], measured = []
  const result = await runAgent(options({ messages: [...old, message('current')],
    context: { sourceId: 'prefix', keepRecentMessages: 2 },
    getContextPrefix() { return [message('private current project data')] },
    provider: { estimateContext(input) { measured.push(input); return estimateContext(input) },
      async generate(input, _signal, opts) { requests.push(input)
        if (opts.purpose === 'context-summary') return answer('older summary')
        if (requests.length === 1) throw Object.assign(Error('overflow'), { code: 'context_overflow' })
        return answer('done') } } }))
  assert.equal(result.status, 'completed')
  assert(result.checkpoint)
  assert.equal(measured[0].messages[0].content, 'private current project data')
  const summary = requests.find(input => input.messages[0].content.includes('Summarize'))
  assert(summary)
  assert.equal(JSON.stringify(summary).includes('private current project data'), false)
  assert.equal(JSON.stringify(result.checkpoint).includes('private current project data'), false)
})

test('overflow retry refreshes once and measures the exact refreshed prefix before retry', async () => {
  const events = [], requests = []
  let pulls = 0
  const history = Array.from({ length: 8 }, (_, index) => [message(`old ${index} ${'x'.repeat(200)}`),
    { kind: 'assistant', content: 'y'.repeat(200), toolCalls: [] }]).flat()
  const result = await runAgent(options({ messages: [...history, message('current')],
    context: { sourceId: 'overflow-prefix', keepRecentMessages: 2, prefixMessages: [message('static', 'system')] },
    getContextPrefix() { events.push(`pull ${++pulls}`); return [message(`dynamic ${pulls}`)] },
    provider: { estimateContext(input) { events.push(`measure ${input.messages.find(item => item.content.startsWith('dynamic'))?.content ?? 'summary'}`); return estimateContext(input) },
      async generate(input, _signal, opts) {
        if (opts.purpose === 'context-summary') return answer('summary')
        requests.push(input)
        events.push(`dispatch ${requests.length}`)
        if (requests.length === 1) throw Object.assign(Error('overflow'), { code: 'context_overflow' })
        return answer('done') } } }))
  assert.equal(result.status, 'completed')
  assert.equal(pulls, 2)
  assert.deepEqual(requests.map(input => input.messages.slice(0, 2).map(item => item.content)),
    [['static', 'dynamic 1'], ['static', 'dynamic 2']])
  assert(events.indexOf('pull 2') < events.indexOf('measure dynamic 2'))
  assert(events.lastIndexOf('measure dynamic 2') < events.indexOf('dispatch 2'))
})

test('invalid prefix fails without provider dispatch and callback failures are explicit', async () => {
  for (const invalid of [null, [{ kind: 'assistant', content: '', toolCalls: [] }], [message('bad', 'developer')],
    [{ ...message('bad'), extra: true }], [{ kind: 'tool_result', callId: 'x', name: 'read', content: '' }]]) {
    let calls = 0
    const result = await runAgent(options({ getContextPrefix() { return invalid },
      provider: { async generate() { calls++; return answer('bad') } } }))
    assert.equal(result.status, 'error'); assert.equal(result.error.code, 'invalid_input'); assert.equal(calls, 0)
  }
  const failed = await runAgent(options({ getContextPrefix() { throw Error('private secret') } }))
  assert.equal(failed.error.code, 'context_error')
  assert.equal(failed.error.message.includes('private secret'), false)
})

test('cancellation interrupts uncooperative prefix wait, observes late rejection and removes listener', async () => {
  const controller = new AbortController()
  let entered, reject
  const started = new Promise(resolve => { entered = resolve })
  const run = runAgent(options({ signal: controller.signal,
    getContextPrefix() { entered(); return new Promise((_resolve, fail) => { reject = fail }) } }))
  await started; controller.abort()
  const result = await run
  reject(Error('late failure'))
  assert.equal(result.status, 'cancelled')
  assert.deepEqual(result.history, [message('goal')])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('pre-aborted runs do not invoke prefix callbacks', async () => {
  const controller = new AbortController(); controller.abort()
  let pulls = 0
  const result = await runAgent(options({ signal: controller.signal, getContextPrefix() { pulls++; return [] } }))
  assert.equal(result.status, 'cancelled'); assert.equal(pulls, 0)
})
