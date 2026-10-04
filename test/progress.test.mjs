// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runAgent } from '../dist/index.js'

const answer = (content = 'Done') => ({ content, toolCalls: [] })
const options = (extras) => ({ messages: [], tools: [], executeTool: async () => { throw new Error('unused') }, ...extras })
const tick = () => new Promise(resolve => setImmediate(resolve))

test('progress is ordered, immutable, display-only and precedes committed assistant', async () => {
  const events = []
  const result = await runAgent(options({
    provider: { async generate(_input, _signal, { onProgress }) {
      const first = onProgress({ type: 'text_delta', text: 'Do', ignored: 'not an event field' })
      const second = onProgress({ type: 'text_delta', text: 'ne' })
      await Promise.all([first, second])
      return answer()
    } },
    async onEvent(event) { assert(Object.isFrozen(event)); await tick(); events.push(event) }
  }))
  assert.equal(result.status, 'completed')
  assert.deepEqual(events.map(event => event.type), ['text_delta', 'text_delta', 'assistant', 'round_completed'])
  assert.deepEqual(events[0], { type: 'text_delta', text: 'Do' })
  assert.deepEqual(result.history, [{ kind: 'assistant', content: 'Done', toolCalls: [] }])
})

test('unawaited progress is drained before accepting the final provider result', async () => {
  const events = []
  const result = await runAgent(options({
    provider: { async generate(_input, _signal, { onProgress }) {
      void onProgress({ type: 'text_delta', text: '1' })
      void onProgress({ type: 'text_delta', text: '2' })
      return answer()
    } },
    async onEvent(event) { await tick(); events.push(event.type === 'text_delta' ? event.text : event.type) }
  }))
  assert.equal(result.status, 'completed')
  assert.deepEqual(events, ['1', '2', 'assistant', 'round_completed'])
})

test('progress hook error terminates an uncooperative provider and aborts its signal', { timeout: 1000 }, async () => {
  let providerSignal
  const result = await runAgent(options({
    provider: { generate(_input, signal, { onProgress }) {
      providerSignal = signal
      void onProgress({ type: 'text_delta', text: 'partial' })
      return new Promise(() => {})
    } },
    onEvent() { throw new Error('Display failed') }
  }))
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'event_error')
  assert.equal(providerSignal.aborted, true)
  assert.deepEqual(result.history, [])
})

test('invalid progress fails even if provider ignores callback rejection', async () => {
  const result = await runAgent(options({
    provider: { async generate(_input, _signal, { onProgress }) {
      void onProgress({ type: 'tool_started', text: 'injected' })
      return answer()
    } }
  }))
  assert.equal(result.error.code, 'invalid_provider_output')
  assert.deepEqual(result.history, [])
})

test('cancelled progress never commits partial assistant and ignores late callbacks', { timeout: 1000 }, async () => {
  const controller = new AbortController()
  const events = []
  let callback
  const result = await runAgent(options({
    signal: controller.signal,
    provider: { generate(_input, _signal, { onProgress }) {
      callback = onProgress
      void onProgress({ type: 'text_delta', text: 'partial' })
      return new Promise(() => {})
    } },
    onEvent(event) { events.push(event); controller.abort() }
  }))
  assert.equal(result.status, 'cancelled')
  assert.deepEqual(result.history, [])
  await callback({ type: 'text_delta', text: 'late' })
  assert.equal(events.length, 1)
})

test('obsolete callback cannot emit after completion or into a later provider round', async () => {
  const events = []
  let oldCallback
  let rounds = 0
  const result = await runAgent({
    messages: [], tools: [{ name: 'read', description: 'read', parameters: {} }],
    executeTool: async () => ({ content: 'read' }),
    provider: { async generate(_input, _signal, { onProgress }) {
      if (++rounds === 1) {
        oldCallback = onProgress
        return { content: '', toolCalls: [{ id: 'a', name: 'read', arguments: {} }] }
      }
      await oldCallback({ type: 'text_delta', text: 'obsolete' })
      return answer()
    } },
    onEvent(event) { events.push(event.type) }
  })
  await oldCallback({ type: 'text_delta', text: 'late' })
  assert.equal(result.status, 'completed')
  assert(!events.includes('text_delta'))
})
