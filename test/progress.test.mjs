// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { test } from 'node:test'
import { runAgent } from '../dist/index.js'
import { ProviderRequestError } from '../dist/providers/openai.js'

const answer = (content = 'Done') => ({ content, toolCalls: [] })
const options = (extras) => ({ messages: [], tools: [], executeTool: async () => { throw new Error('unused') }, ...extras })
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

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

test('timed-out rounds release hanging progress waits and leave late or queued callbacks inert', { timeout: 1000 }, async () => {
  const controller = new AbortController()
  // Reuse the caller signal: detached hook waits must not accumulate listeners across runs.
  for (const settlement of ['never', 'resolve', 'reject']) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const entered = deferred()
      const hook = deferred()
      const failure = deferred()
      const events = []
      const progress = []
      let callback, providerSignal
      const run = runAgent(options({
        signal: controller.signal,
        provider: { generate(_input, signal, { onProgress }) {
          providerSignal = signal
          callback = onProgress
          progress.push(onProgress({ type: 'text_delta', text: 'first' }))
          progress.push(onProgress({ type: 'text_delta', text: 'queued' }))
          return failure.promise
        } },
        onEvent(event) { events.push(event); entered.resolve(); return hook.promise }
      }))
      await entered.promise
      failure.reject(new ProviderRequestError('OpenAI', 'timeout', 'OpenAI request timed out'))
      const result = await run
      assert.equal(result.status, 'error')
      assert.deepEqual(result.error, { code: 'provider_error', message: 'OpenAI request timed out' })
      assert.deepEqual(result.history, [])
      assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
      assert.equal(result.rounds, 0)
      assert.equal(result.content, '')
      assert.equal(providerSignal.aborted, true)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
      assert.equal(getEventListeners(providerSignal, 'abort').length, 0)
      await Promise.allSettled(progress)
      if (settlement === 'resolve') hook.resolve()
      if (settlement === 'reject') hook.reject(new Error('late hook rejection'))
      await callback({ type: 'text_delta', text: 'late' })
      assert.deepEqual(events, [{ type: 'text_delta', text: 'first' }])
      assert.deepEqual(result.error, { code: 'provider_error', message: 'OpenAI request timed out' })
    }
  }
})

test('caller cancellation releases an outstanding progress hook wait with cancelled status', { timeout: 1000 }, async () => {
  const controller = new AbortController()
  const entered = deferred()
  let progress, callback, providerSignal
  const events = []
  const run = runAgent(options({
    signal: controller.signal,
    provider: { generate(_input, signal, { onProgress }) {
      providerSignal = signal
      callback = onProgress
      progress = onProgress({ type: 'text_delta', text: 'first' })
      return new Promise(() => {})
    } },
    onEvent(event) { events.push(event); entered.resolve(); return new Promise(() => {}) }
  }))
  await entered.promise
  controller.abort()
  const result = await run
  await Promise.allSettled([progress])
  assert.equal(result.status, 'cancelled')
  assert.deepEqual(result.history, [])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(getEventListeners(providerSignal, 'abort').length, 0)
  await callback({ type: 'text_delta', text: 'late' })
  assert.deepEqual(events, [{ type: 'text_delta', text: 'first' }])
})

test('cleanup of a pending hook cannot replace an invalid progress failure', { timeout: 1000 }, async () => {
  const controller = new AbortController()
  const entered = deferred()
  let callback, progress
  const run = runAgent(options({
    signal: controller.signal,
    provider: { generate(_input, _signal, { onProgress }) {
      callback = onProgress
      progress = onProgress({ type: 'text_delta', text: 'first' })
      return new Promise(() => {})
    } },
    onEvent() { entered.resolve(); return new Promise(() => {}) }
  }))
  await entered.promise
  await assert.rejects(callback({ type: 'tool_started', text: 'invalid' }))
  const result = await run
  await Promise.allSettled([progress])
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'invalid_provider_output')
  assert.deepEqual(result.history, [])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
