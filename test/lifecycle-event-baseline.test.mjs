// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runAgent } from '../dist/index.js'

// CORE-10 baseline: the live callback feed is deliberately not a durable settlement log.
const call = { id: 'fixture-call', name: 'fixture', arguments: {} }
const tool = { name: 'fixture', description: 'Owned offline fixture', parameters: {} }
const usage = { inputTokens: 8, outputTokens: 2, totalTokens: 12, cachedInputTokens: 3 }

test('hook failure retains accepted history and usage without round or terminal callbacks', async () => {
  const events = []
  const result = await runAgent({
    provider: { async generate() { return { content: 'accepted', toolCalls: [call], usage } } },
    messages: [], tools: [tool], executeTool: async () => { throw new Error('Must not execute') },
    onEvent(event) { events.push(event.type); throw new Error('Owned display hook failure') }
  })
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'event_error')
  assert.deepEqual(events, ['assistant'])
  assert.deepEqual(result.usage, usage)
  assert.deepEqual(result.history.map(message => message.kind), ['assistant', 'tool_result'])
  assert.equal(JSON.parse(result.history.at(-1).content).error.code, 'run_failed')
})

test('tool_started precedes dispatch and cancellation settles accepted usage only in the result', async () => {
  const controller = new AbortController()
  const events = []
  let executed = false
  const result = await runAgent({
    signal: controller.signal,
    provider: { async generate() { return { content: '', toolCalls: [call], usage } } },
    messages: [], tools: [tool],
    executeTool: async () => { executed = true; return { content: 'unexpected' } },
    onEvent(event) { events.push(event.type); if (event.type === 'tool_started') controller.abort() }
  })
  assert.equal(result.status, 'cancelled')
  assert.equal(executed, false)
  assert.deepEqual(events, ['assistant', 'tool_started'])
  assert.equal(JSON.parse(result.history.at(-1).content).error.code, 'cancelled')
  assert.deepEqual(result.usage, usage)
})

test('an entered trusted event callback can settle after cancellation without changing returned history', async () => {
  const controller = new AbortController()
  let release, entered
  const blocked = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { entered = resolve })
  let completed = false
  const running = runAgent({
    signal: controller.signal,
    provider: { async generate() { return { content: 'accepted', toolCalls: [], usage } } },
    messages: [], tools: [], executeTool: async () => { throw new Error('Must not execute') },
    async onEvent(event) {
      assert.equal(event.type, 'assistant')
      entered()
      await blocked
      completed = true
    }
  })
  await ready
  controller.abort()
  const result = await running
  const before = structuredClone(result)
  assert.equal(result.status, 'cancelled')
  assert.equal(completed, false)
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, true)
  assert.deepEqual(result, before)
})
