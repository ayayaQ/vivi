// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { test as nodeTest } from 'node:test'
import { runAgent } from '../dist/index.js'

const test = (name, fn) => nodeTest(name, { timeout: 3000 }, fn)
const user = { kind: 'message', role: 'user', content: 'Continue' }
const tool = { name: 'lookup', description: 'Look up a value', parameters: {} }
const call = (id, name = 'lookup', arguments_ = {}) => ({ id, name, arguments: arguments_ })
const answer = (content = 'Done', toolCalls = [], extra = {}) => ({ content, toolCalls, ...extra })
// Provider totals need not equal input plus output. Cache fields are independent subsets.
const counts = { inputTokens: 12, outputTokens: 4, totalTokens: 19, cachedInputTokens: 2, cacheWriteInputTokens: 0 }
const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
const options = (extra = {}) => ({
  messages: [user], tools: [tool], provider: { async generate() { return answer() } },
  async executeTool() { return { content: 'Found' } }, ...extra
})
const deferred = () => {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const within = async (promise) => {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Run did not settle after cancellation')), 750)
    })])
  } finally { clearTimeout(timer) }
}
const frozenTree = (value) => {
  if (value === null || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) frozenTree(child)
}
const label = (event) => `${event.type}:${event.call?.id ?? event.message?.callId ?? event.round ?? ''}`
const failure = (message, id, code) => {
  assert.equal(message.kind, 'tool_result')
  assert.equal(message.callId, id)
  assert.equal(message.name, 'lookup')
  assert.equal(message.isError, true)
  assert.equal(JSON.parse(message.content).error.code, code)
}
const noListeners = (...signals) => {
  for (const signal of signals) assert.equal(getEventListeners(signal, 'abort').length, 0)
}

test('omitting onAccepted preserves ordered legacy progress, event snapshots and dispatch', async () => {
  const order = []
  const events = []
  let rounds = 0
  const result = await runAgent(options({
    provider: { async generate(_input, _signal, { onProgress }) {
      order.push(`generate:${++rounds}`)
      await onProgress({ type: 'text_delta', text: `part:${rounds}` })
      return rounds === 1 ? answer('Looking', [call('a'), call('b')], { usage: counts }) : answer()
    } },
    async executeTool(requested) { order.push(`execute:${requested.id}`); return { content: requested.id } },
    async onEvent(event) { frozenTree(event); events.push(event); order.push(label(event)); await tick() }
  }))
  assert.equal(result.status, 'completed')
  assert.deepEqual(order, [
    'generate:1', 'text_delta:', 'assistant:', 'tool_started:a', 'execute:a', 'tool_completed:a',
    'tool_started:b', 'execute:b', 'tool_completed:b', 'round_completed:',
    'generate:2', 'text_delta:', 'assistant:', 'round_completed:'
  ])
  assert.deepEqual(result.history, [user,
    { kind: 'assistant', content: 'Looking', toolCalls: [call('a'), call('b')] },
    { kind: 'tool_result', callId: 'a', name: 'lookup', content: 'a' },
    { kind: 'tool_result', callId: 'b', name: 'lookup', content: 'b' },
    { kind: 'assistant', content: 'Done', toolCalls: [] }
  ])
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 4, totalTokens: 19 })
  assert.deepEqual(events.filter(event => event.type === 'round_completed').map(event => event.usage), [counts, undefined])
})

test('omitting onAccepted adds no awaited no-op between tool acceptance and legacy completion', async () => {
  const controller = new AbortController()
  const events = []
  const order = []
  const result = await runAgent(options({
    signal: controller.signal,
    provider: { async generate() { return answer('Looking', [call('a')], { usage: counts }) } },
    executeTool() {
      return { then(resolve) {
        resolve({ content: 'Accepted before abort' })
        queueMicrotask(() => {
          order.push('first microtask')
          queueMicrotask(() => { order.push('abort'); controller.abort() })
        })
      } }
    },
    onEvent(event) { events.push(event.type); if (event.type === 'tool_completed') order.push('tool_completed') }
  }))
  assert.equal(result.status, 'cancelled')
  assert.deepEqual(events, ['assistant', 'tool_started', 'tool_completed'])
  assert.deepEqual(order, ['first microtask', 'tool_completed', 'abort'])
  assert.equal(result.history.length, 3)
  assert.equal(result.history[2].content, 'Accepted before abort')
  assert.equal(result.history[2].isError, undefined)
  assert.deepEqual(result.usage, counts)
  noListeners(controller.signal)
})

test('acceptance is awaited in order before legacy events, tool dispatch and the next round', async () => {
  const order = []
  const updates = []
  const gates = Array.from({ length: 4 }, () => ({ entered: deferred(), release: deferred() }))
  let rounds = 0
  const run = runAgent(options({
    provider: { async generate({ messages }, _signal, { onProgress }) {
      order.push(`generate:${++rounds}`)
      if (rounds === 2) assert.deepEqual(messages.slice(-2).map(message => message.callId), ['a', 'b'])
      await onProgress({ type: 'text_delta', text: `partial:${rounds}` })
      return rounds === 1 ? answer('Looking', [call('a'), call('b')], { usage: counts }) : answer('Finished')
    } },
    async executeTool(requested) { order.push(`execute:${requested.id}`); return { content: requested.id } },
    async onAccepted(update) {
      const index = updates.length
      updates.push(update)
      order.push(`enter:${label(update)}`)
      gates[index].entered.resolve()
      await gates[index].release.promise
      order.push(`leave:${label(update)}`)
    },
    async onEvent(event) { order.push(label(event)); await tick() }
  }))
  const prefixes = [
    ['generate:1', 'text_delta:', 'enter:assistant_accepted:1'],
    ['leave:assistant_accepted:1', 'assistant:', 'tool_started:a', 'execute:a', 'enter:tool_result_accepted:a'],
    ['leave:tool_result_accepted:a', 'tool_completed:a', 'tool_started:b', 'execute:b', 'enter:tool_result_accepted:b'],
    ['leave:tool_result_accepted:b', 'tool_completed:b', 'round_completed:', 'generate:2', 'text_delta:', 'enter:assistant_accepted:2']
  ]
  let expected = []
  for (const [index, gate] of gates.entries()) {
    await gate.entered.promise
    expected.push(...prefixes[index])
    await tick()
    assert.deepEqual(order, expected, 'nothing may overtake an outstanding acceptance hook')
    gate.release.resolve()
  }
  const result = await run
  assert.equal(result.status, 'completed')
  assert.deepEqual(order, [...expected, 'leave:assistant_accepted:2', 'assistant:', 'round_completed:'])
  assert.deepEqual(updates.map(update => [update.type, update.round]), [
    ['assistant_accepted', 1], ['tool_result_accepted', 1], ['tool_result_accepted', 1], ['assistant_accepted', 2]
  ])
  assert.deepEqual(updates[0].usage, counts)
  assert.deepEqual(updates[0].aggregateUsage, counts)
  assert.equal(Object.hasOwn(updates[3], 'usage'), false)
  assert.deepEqual(updates[3].aggregateUsage, { inputTokens: 12, outputTokens: 4, totalTokens: 19 })
})

test('accepted snapshots are deeply frozen and detached from outputs, legacy events and returned history', async () => {
  const nestedCall = call('a', 'lookup', { nested: [{ value: [1, true, null] }] })
  const state = { provider: 'fixture', items: [{ opaque: ['saved', { count: 1 }] }] }
  const first = answer('Looking', [nestedCall], { usage: { ...counts }, providerState: state })
  const output = { content: 'Found', isError: false }
  const updates = [], events = [], queries = [], dispatches = []
  let rounds = 0
  const result = await runAgent(options({
    provider: { async generate(input) {
      queries.push(input)
      return ++rounds === 1 ? first : answer('Finished', [], { usage: { ...counts } })
    } },
    async executeTool(requested) { dispatches.push(requested); return output },
    onAccepted(update) {
      frozenTree(update)
      assert.throws(() => { update.message.content = 'edited' }, TypeError)
      if (update.type === 'assistant_accepted') {
        assert.throws(() => { update.aggregateUsage.inputTokens = 999 }, TypeError)
        assert.throws(() => { update.usage.cachedInputTokens = 999 }, TypeError)
        if (update.round === 1) {
          assert.throws(() => { update.message.toolCalls[0].arguments.nested[0].value.push(2) }, TypeError)
          assert.throws(() => { update.message.providerState.items[0].opaque[1].count = 2 }, TypeError)
        }
      }
      updates.push(update)
    },
    onEvent(event) { events.push(event) }
  }))
  assert.equal(result.status, 'completed')
  const assistantEvent = events.find(event => event.type === 'assistant')
  const completionEvent = events.find(event => event.type === 'tool_completed')
  assert.notEqual(updates[0].message, result.history[1])
  assert.notEqual(updates[0].message, assistantEvent.message)
  assert.notEqual(updates[0].message.toolCalls, first.toolCalls)
  assert.notEqual(updates[0].message.toolCalls[0].arguments, dispatches[0].arguments)
  assert.notEqual(updates[0].message.providerState.items, first.providerState.items)
  assert.notEqual(updates[0].message, queries[1].messages[1])
  assert.notEqual(updates[0].usage, first.usage)
  assert.notEqual(updates[0].aggregateUsage, result.usage)
  assert.notEqual(updates[1].message, result.history[2])
  assert.notEqual(updates[1].message, completionEvent.message)
  assert.deepEqual(updates[0].aggregateUsage, counts, 'later accepted rounds cannot mutate an older snapshot')
  assert.deepEqual(updates[2].aggregateUsage, { inputTokens: 24, outputTokens: 8, totalTokens: 38, cachedInputTokens: 4, cacheWriteInputTokens: 0 })
  const saved = structuredClone(updates)
  first.content = 'provider edited'
  first.toolCalls[0].arguments.nested[0].value.push('provider edit')
  first.providerState.items.push('provider edit')
  first.usage.inputTokens = 999
  output.content = 'tool edited'
  result.history[1].content = 'caller edited'
  result.history[1].toolCalls[0].arguments.nested[0].value.push('caller edit')
  result.history[1].providerState.items.push('caller edit')
  result.history[2].content = 'caller edited'
  result.usage.inputTokens = 999
  assert.deepEqual(updates, saved)
})

test('each assistant acceptance reports original round usage and independent complete cache aggregates', async () => {
  const base = { inputTokens: 12, outputTokens: 4, totalTokens: 19 }
  const both = { ...base, cachedInputTokens: 2, cacheWriteInputTokens: 3 }
  for (const [usages, expected] of [
    [[both, both, both], { inputTokens: 36, outputTokens: 12, totalTokens: 57, cachedInputTokens: 6, cacheWriteInputTokens: 9 }],
    [[both, { ...base, cachedInputTokens: 0 }, both], { inputTokens: 36, outputTokens: 12, totalTokens: 57, cachedInputTokens: 4 }],
    [[both, { ...base, cacheWriteInputTokens: 0 }, both], { inputTokens: 36, outputTokens: 12, totalTokens: 57, cacheWriteInputTokens: 6 }],
    [[base, both], { inputTokens: 24, outputTokens: 8, totalTokens: 38 }],
    [[both, undefined, both], { inputTokens: 24, outputTokens: 8, totalTokens: 38 }],
    [[undefined, both], { inputTokens: 12, outputTokens: 4, totalTokens: 19 }],
    [[undefined, undefined], emptyUsage],
    [[{ ...base, cachedInputTokens: 0, cacheWriteInputTokens: 0 }, { ...base, cachedInputTokens: 0, cacheWriteInputTokens: 0 }],
      { inputTokens: 24, outputTokens: 8, totalTokens: 38, cachedInputTokens: 0, cacheWriteInputTokens: 0 }]
  ]) {
    const accepted = [], completed = []
    let index = 0
    const result = await runAgent(options({
      provider: { async generate() {
        const roundUsage = usages[index++]
        return answer(`round:${index}`, index < usages.length ? [call(`a-${index}`)] : [],
          roundUsage === undefined ? {} : { usage: roundUsage })
      } },
      onAccepted(update) { if (update.type === 'assistant_accepted') accepted.push(update) },
      onEvent(event) { if (event.type === 'round_completed') completed.push(event) }
    }))
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.usage, expected)
    assert.deepEqual(accepted.map(update => update.round), usages.map((_, index) => index + 1))
    assert.deepEqual(accepted.map(update => update.usage), usages)
    assert.deepEqual(completed.map(event => event.usage), usages)
    assert.deepEqual(accepted.at(-1).aggregateUsage, expected)
    let running = { ...emptyUsage }
    let inputComplete = true, writeComplete = true
    for (const [index, update] of accepted.entries()) {
      const roundUsage = usages[index]
      for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) running[key] += roundUsage?.[key] ?? 0
      inputComplete &&= roundUsage?.cachedInputTokens !== undefined
      writeComplete &&= roundUsage?.cacheWriteInputTokens !== undefined
      if (inputComplete) running.cachedInputTokens = (running.cachedInputTokens ?? 0) + roundUsage.cachedInputTokens
      else delete running.cachedInputTokens
      if (writeComplete) running.cacheWriteInputTokens = (running.cacheWriteInputTokens ?? 0) + roundUsage.cacheWriteInputTokens
      else delete running.cacheWriteInputTokens
      assert.deepEqual(update.aggregateUsage, running)
      assert.equal(Object.hasOwn(update, 'usage'), roundUsage !== undefined)
      for (const key of ['cachedInputTokens', 'cacheWriteInputTokens']) {
        assert.equal(Object.hasOwn(update.aggregateUsage, key), Object.hasOwn(running, key))
      }
    }
  }
})

test('onAccepted is validated and captured once, even when its getter or options change later', async () => {
  const updates = []
  let reads = 0, rounds = 0
  const original = (update) => {
    updates.push(label(update))
    Object.defineProperty(input, 'onAccepted', { value() { throw new Error('replacement must not run') }, configurable: true })
  }
  const input = options({
    provider: { async generate() { return ++rounds === 1 ? answer('Looking', [call('a')]) : answer() } }
  })
  Object.defineProperty(input, 'onAccepted', { configurable: true, get() { reads++; return original } })
  const result = await runAgent(input)
  assert.equal(result.status, 'completed')
  assert.equal(reads, 1)
  assert.deepEqual(updates, ['assistant_accepted:1', 'tool_result_accepted:a', 'assistant_accepted:2'])
  let absentReads = 0
  const absent = options()
  Object.defineProperty(absent, 'onAccepted', { get() { absentReads++; return undefined } })
  assert.equal((await runAgent(absent)).status, 'completed')
  assert.equal(absentReads, 1)
})

test('invalid onAccepted fails input validation before provider generation or callbacks', async () => {
  for (const hook of [null, false, 'callback', 1, {}, []]) {
    let touched = 0
    const result = await runAgent(options({
      onAccepted: hook,
      provider: { async generate() { touched++; return answer() } },
      onEvent() { touched++ }, executeTool() { touched++; return Promise.resolve({ content: 'unused' }) }
    }))
    assert.equal(result.status, 'error')
    assert.deepEqual(result.error, { code: 'invalid_input', message: 'onAccepted must be a function' })
    assert.deepEqual(result.history, [user])
    assert.deepEqual(result.usage, emptyUsage)
    assert.equal(result.rounds, 0)
    assert.equal(touched, 0)
  }
})

for (const target of ['assistant_accepted', 'tool_result_accepted']) {
  for (const mode of ['throw', 'reject']) {
    test(`${mode} from ${target} retains accepted state and closes only pending calls without callbacks`, async () => {
      const controller = new AbortController()
      // An error leaves the caller signal reusable; listeners must not accumulate over runs.
      for (let attempt = 0; attempt < 3; attempt++) {
        const updates = [], events = [], dispatches = []
        let providerSignal, progress
        const result = await runAgent(options({
          signal: controller.signal,
          provider: { async generate(_input, signal, { onProgress }) {
            providerSignal = signal; progress = onProgress
            return answer('Accepted work', [call('a'), call('b')], { usage: counts })
          } },
          async executeTool(requested) { dispatches.push(requested.id); return { content: 'Accepted tool', isError: false } },
          onAccepted(update) {
            updates.push(update)
            if (update.type !== target) return
            const error = new Error(`${target} failed`)
            if (mode === 'throw') throw error
            return Promise.reject(error)
          },
          onEvent(event) { events.push(event.type) }
        }))
        assert.equal(result.status, 'error')
        assert.deepEqual(result.error, { code: 'event_error', message: `${target} failed` })
        assert.equal(result.rounds, 1)
        assert.equal(result.content, 'Accepted work')
        assert.deepEqual(result.usage, counts)
        assert.deepEqual(result.history[1], { kind: 'assistant', content: 'Accepted work', toolCalls: [call('a'), call('b')] })
        assert.deepEqual(updates[0].aggregateUsage, counts)
        assert.deepEqual(updates[0].usage, counts)
        assert.equal(result.history.length, 4)
        if (target === 'assistant_accepted') {
          assert.deepEqual(updates.map(update => update.type), ['assistant_accepted'])
          assert.deepEqual(events, [])
          assert.deepEqual(dispatches, [])
          failure(result.history[2], 'a', 'run_failed')
        } else {
          assert.deepEqual(updates.map(update => update.type), ['assistant_accepted', 'tool_result_accepted'])
          assert.deepEqual(events, ['assistant', 'tool_started'])
          assert.deepEqual(dispatches, ['a'])
          assert.deepEqual(result.history[2], { kind: 'tool_result', callId: 'a', name: 'lookup', content: 'Accepted tool', isError: false })
          assert.deepEqual(updates[1].message, result.history[2])
        }
        failure(result.history[3], 'b', 'run_failed')
        assert.equal(providerSignal.aborted, true)
        noListeners(controller.signal, providerSignal)
        const before = structuredClone({ updates, events, result })
        await progress({ type: 'text_delta', text: 'obsolete' })
        await tick()
        assert.deepEqual({ updates, events, result }, before)
        noListeners(controller.signal, providerSignal)
      }
    })
  }

  for (const settlement of ['never', 'resolve', 'reject']) {
    test(`abort releases hanging ${target}, ignores late ${settlement} and emits no cleanup acceptance`, async () => {
      const controller = new AbortController()
      const entered = deferred(), hook = deferred()
      const updates = [], events = [], dispatches = []
      let providerSignal, progress
      const run = runAgent(options({
        signal: controller.signal,
        provider: { async generate(_input, signal, { onProgress }) {
          providerSignal = signal; progress = onProgress
          return answer('Accepted work', [call('a'), call('b')], { usage: counts })
        } },
        async executeTool(requested) { dispatches.push(requested.id); return { content: 'Accepted tool' } },
        onAccepted(update) {
          updates.push(update)
          if (update.type === target) { entered.resolve(); return hook.promise }
        },
        onEvent(event) { events.push(event.type) }
      }))
      await entered.promise
      await tick()
      assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
      controller.abort()
      const result = await within(run)
      assert.equal(result.status, 'cancelled')
      assert.equal(Object.hasOwn(result, 'error'), false)
      assert.equal(result.rounds, 1)
      assert.equal(result.content, 'Accepted work')
      assert.deepEqual(result.usage, counts)
      assert.deepEqual(result.history[1], { kind: 'assistant', content: 'Accepted work', toolCalls: [call('a'), call('b')] })
      assert.equal(result.history.length, 4)
      if (target === 'assistant_accepted') {
        assert.deepEqual(updates.map(update => update.type), ['assistant_accepted'])
        assert.deepEqual(events, [])
        assert.deepEqual(dispatches, [])
        failure(result.history[2], 'a', 'cancelled')
      } else {
        assert.deepEqual(updates.map(update => update.type), ['assistant_accepted', 'tool_result_accepted'])
        assert.deepEqual(events, ['assistant', 'tool_started'])
        assert.deepEqual(dispatches, ['a'])
        assert.deepEqual(result.history[2], { kind: 'tool_result', callId: 'a', name: 'lookup', content: 'Accepted tool' })
        assert.deepEqual(updates[1].message, result.history[2])
      }
      failure(result.history[3], 'b', 'cancelled')
      noListeners(controller.signal, providerSignal)
      const before = structuredClone({ updates, events, dispatches, result })
      if (settlement === 'resolve') hook.resolve()
      if (settlement === 'reject') hook.reject(new Error('obsolete acceptance rejection'))
      await progress({ type: 'text_delta', text: 'obsolete progress' })
      await tick()
      assert.deepEqual({ updates, events, dispatches, result }, before)
      noListeners(controller.signal, providerSignal)
    })
  }

  test(`abort takes precedence over a simultaneous ${target} throw`, async () => {
    const controller = new AbortController()
    const updates = []
    const result = await runAgent(options({
      signal: controller.signal,
      provider: { async generate() { return answer('Accepted work', [call('a'), call('b')], { usage: counts }) } },
      onAccepted(update) {
        updates.push(update.type)
        if (update.type === target) { controller.abort(); throw new Error('abort wins') }
      }
    }))
    assert.equal(result.status, 'cancelled')
    assert.equal(Object.hasOwn(result, 'error'), false)
    assert.deepEqual(result.usage, counts)
    assert.deepEqual(updates, target === 'assistant_accepted' ? ['assistant_accepted'] : ['assistant_accepted', 'tool_result_accepted'])
    failure(result.history.at(-1), 'b', 'cancelled')
    noListeners(controller.signal)
  })
}

test('legacy onEvent failure follows acceptance and produces no synthetic accepted cleanup updates', async () => {
  for (const target of ['assistant', 'tool_started', 'tool_completed', 'round_completed']) {
    const updates = [], events = []
    const result = await runAgent(options({
      provider: { async generate() { return answer('Accepted work', [call('a')], { usage: counts }) } },
      onAccepted(update) { updates.push(update.type) },
      onEvent(event) { events.push(event.type); if (event.type === target) throw new Error('legacy failed') }
    }))
    assert.equal(result.status, 'error')
    assert.deepEqual(result.error, { code: 'event_error', message: 'legacy failed' })
    assert.deepEqual(result.usage, counts)
    const completedTool = target === 'tool_completed' || target === 'round_completed'
    assert.deepEqual(updates, completedTool ? ['assistant_accepted', 'tool_result_accepted'] : ['assistant_accepted'])
    assert.equal(result.history.length, 3)
    if (completedTool) assert.equal(result.history[2].content, 'Found')
    else failure(result.history[2], 'a', 'run_failed')
    assert.equal(events.at(-1), target)
  }
})

test('a later assistant acceptance failure retains both rounds, current usage and only its pending closures', async () => {
  const secondUsage = { inputTokens: 5, outputTokens: 2, totalTokens: 11, cacheWriteInputTokens: 3 }
  const accepted = [], events = [], dispatched = []
  let rounds = 0
  const result = await runAgent(options({
    provider: { async generate() {
      return ++rounds === 1 ? answer('First', [call('a')], { usage: counts }) :
        answer('Second', [call('b'), call('c')], { usage: secondUsage })
    } },
    async executeTool(requested) { dispatched.push(requested.id); return { content: 'First result' } },
    onAccepted(update) {
      accepted.push(update)
      if (update.type === 'assistant_accepted' && update.round === 2) throw new Error('later acceptance failed')
    },
    onEvent(event) { events.push(event.type) }
  }))
  assert.equal(result.status, 'error')
  assert.deepEqual(result.error, { code: 'event_error', message: 'later acceptance failed' })
  assert.equal(result.rounds, 2)
  assert.equal(result.content, 'Second')
  assert.deepEqual(result.usage, { inputTokens: 17, outputTokens: 6, totalTokens: 30, cacheWriteInputTokens: 3 })
  assert.deepEqual(accepted.at(-1).usage, secondUsage)
  assert.deepEqual(accepted.at(-1).aggregateUsage, result.usage)
  assert.deepEqual(accepted[0].aggregateUsage, counts)
  assert.deepEqual(accepted.map(update => update.type), ['assistant_accepted', 'tool_result_accepted', 'assistant_accepted'])
  assert.deepEqual(dispatched, ['a'])
  assert.deepEqual(events, ['assistant', 'tool_started', 'tool_completed', 'round_completed'])
  assert.equal(result.history.length, 6)
  assert.deepEqual(result.history[2], { kind: 'tool_result', callId: 'a', name: 'lookup', content: 'First result' })
  failure(result.history[4], 'b', 'run_failed')
  failure(result.history[5], 'c', 'run_failed')
})

test('ordinary unavailable and failed tool results are accepted once, while cleanup closures are not', async () => {
  const accepted = []
  const calls = [call('unavailable', 'missing'), call('throws'), call('malformed'), call('explicit')]
  let rounds = 0
  const dispatched = []
  const result = await runAgent(options({
    provider: { async generate() { return ++rounds === 1 ? answer('Looking', calls) : answer() } },
    async executeTool(requested) {
      dispatched.push(requested.id)
      if (requested.id === 'throws') throw new Error('host failed')
      if (requested.id === 'malformed') return { content: 123 }
      return { content: 'host error', isError: true }
    },
    onAccepted(update) { accepted.push(update) }
  }))
  assert.equal(result.status, 'completed')
  assert.deepEqual(dispatched, ['throws', 'malformed', 'explicit'])
  const tools = accepted.filter(update => update.type === 'tool_result_accepted')
  assert.deepEqual(tools.map(update => update.message.callId), calls.map(requested => requested.id))
  assert.deepEqual(tools.map(update => update.round), [1, 1, 1, 1])
  assert.equal(JSON.parse(tools[0].message.content).error.code, 'unavailable_tool')
  assert.equal(JSON.parse(tools[1].message.content).error.code, 'tool_error')
  assert.equal(JSON.parse(tools[2].message.content).error.code, 'tool_error')
  assert.deepEqual(tools[3].message, { kind: 'tool_result', callId: 'explicit', name: 'lookup', content: 'host error', isError: true })
  assert.deepEqual(tools.map(update => update.message), result.history.slice(2, -1))
  assert.deepEqual(accepted.map(update => update.type), ['assistant_accepted', ...Array(4).fill('tool_result_accepted'), 'assistant_accepted'])
})

test('unaccepted malformed provider turns and usage never invoke onAccepted', async () => {
  for (const output of [
    answer('Malformed calls', [call('a'), call('a')], { usage: counts }),
    answer('Malformed usage', [call('a')], { usage: { ...counts, cachedInputTokens: -1 } }),
    answer('Malformed state', [call('a')], { providerState: { provider: 'fixture', items: [undefined] } })
  ]) {
    const accepted = [], events = [], dispatches = []
    const result = await runAgent(options({
      provider: { async generate() { return output } },
      async executeTool(requested) { dispatches.push(requested); return { content: 'unexpected' } },
      onAccepted(update) { accepted.push(update) }, onEvent(event) { events.push(event) }
    }))
    assert.equal(result.status, 'error')
    assert.equal(result.error.code, 'invalid_provider_output')
    assert.deepEqual(result.history, [user])
    assert.equal(result.rounds, 0)
    assert.deepEqual(result.usage, emptyUsage)
    assert.deepEqual({ accepted, events, dispatches }, { accepted: [], events: [], dispatches: [] })
  }
})

test('provider failure and cancellation before acceptance cannot create late canonical entries', async () => {
  for (const settlement of ['resolve', 'reject']) {
    const controller = new AbortController()
    const entered = deferred(), output = deferred()
    const accepted = [], events = []
    let providerSignal, progress
    const run = runAgent(options({
      signal: controller.signal,
      provider: { generate(_input, signal, { onProgress }) {
        providerSignal = signal; progress = onProgress; entered.resolve(); return output.promise
      } },
      onAccepted(update) { accepted.push(update) }, onEvent(event) { events.push(event) }
    }))
    await entered.promise
    controller.abort()
    const result = await within(run)
    assert.equal(result.status, 'cancelled')
    assert.deepEqual(result.history, [user])
    assert.deepEqual(result.usage, emptyUsage)
    assert.equal(result.rounds, 0)
    noListeners(controller.signal, providerSignal)
    if (settlement === 'resolve') output.resolve(answer('Obsolete', [call('late')], { usage: counts }))
    else output.reject(new Error('obsolete provider rejection'))
    await progress({ type: 'text_delta', text: 'obsolete' })
    await tick()
    assert.deepEqual(accepted, [])
    assert.deepEqual(events, [])
    assert.deepEqual(result.history, [user])
    noListeners(controller.signal, providerSignal)
  }
  let accepted = 0
  const failed = await runAgent(options({
    provider: { async generate() { throw new Error('provider failed') } }, onAccepted() { accepted++ }
  }))
  assert.equal(failed.error.code, 'provider_error')
  assert.deepEqual(failed.history, [user])
  assert.equal(accepted, 0)
})

test('already cancelled runs and failed transient progress have no accepted updates', async () => {
  const controller = new AbortController()
  controller.abort()
  let touched = 0
  const before = await runAgent(options({
    signal: controller.signal,
    provider: { async generate() { touched++; return answer('unused') } },
    onAccepted() { touched++ }, onEvent() { touched++ }
  }))
  assert.equal(before.status, 'cancelled')
  assert.equal(touched, 0)
  assert.deepEqual(before.history, [user])
  assert.deepEqual(before.usage, emptyUsage)
  noListeners(controller.signal)
  const accepted = [], events = []
  let providerSignal, progress
  const failed = await runAgent(options({
    provider: { generate(_input, signal, { onProgress }) {
      providerSignal = signal; progress = onProgress
      void onProgress({ type: 'text_delta', text: 'Display only' })
      return new Promise(() => {})
    } },
    onAccepted(update) { accepted.push(update) },
    onEvent(event) { events.push(event.type); throw new Error('display failed') }
  }))
  assert.equal(failed.status, 'error')
  assert.deepEqual(failed.error, { code: 'event_error', message: 'display failed' })
  assert.equal(failed.rounds, 0)
  assert.deepEqual(failed.history, [user])
  assert.deepEqual(failed.usage, emptyUsage)
  assert.deepEqual(accepted, [])
  assert.deepEqual(events, ['text_delta'])
  assert.equal(providerSignal.aborted, true)
  noListeners(providerSignal)
  await progress({ type: 'text_delta', text: 'obsolete' })
  await tick()
  assert.deepEqual(accepted, [])
  assert.deepEqual(events, ['text_delta'])
})

test('a cancelled tool wait closes history without accepting a late host result', async () => {
  for (const settlement of ['resolve', 'reject']) {
    const controller = new AbortController()
    const entered = deferred(), output = deferred()
    const accepted = [], events = [], dispatched = []
    const run = runAgent(options({
      signal: controller.signal,
      provider: { async generate() { return answer('Accepted work', [call('a'), call('b')], { usage: counts }) } },
      executeTool(requested) { dispatched.push(requested.id); entered.resolve(); return output.promise },
      onAccepted(update) { accepted.push(update) }, onEvent(event) { events.push(event.type) }
    }))
    await entered.promise
    controller.abort()
    const result = await within(run)
    assert.equal(result.status, 'cancelled')
    assert.deepEqual(result.usage, counts)
    assert.deepEqual(accepted.map(update => update.type), ['assistant_accepted'])
    assert.deepEqual(events, ['assistant', 'tool_started'])
    failure(result.history[2], 'a', 'cancelled')
    failure(result.history[3], 'b', 'cancelled')
    noListeners(controller.signal)
    const before = structuredClone({ accepted, events, dispatched, result })
    if (settlement === 'resolve') output.resolve({ content: 'obsolete host success' })
    else output.reject(new Error('obsolete host rejection'))
    await tick()
    assert.deepEqual({ accepted, events, dispatched, result }, before)
    noListeners(controller.signal)
  }
})

test('acceptance hooks do not acknowledge final completion or max-rounds cleanup', async () => {
  const accepted = []
  const limited = await runAgent(options({
    maxRounds: 1,
    provider: { async generate() { return answer('Looking', [call('a')], { usage: counts }) } },
    onAccepted(update) { accepted.push(update.type) }
  }))
  assert.equal(limited.status, 'error')
  assert.equal(limited.error.code, 'max_rounds')
  assert.deepEqual(limited.usage, counts)
  assert.deepEqual(accepted, ['assistant_accepted', 'tool_result_accepted'])
  assert.equal(limited.history[2].content, 'Found')
  const completed = []
  const result = await runAgent(options({ onAccepted(update) { completed.push(update.type) } }))
  assert.equal(result.status, 'completed')
  assert.deepEqual(completed, ['assistant_accepted'])
})
