// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { test as nodeTest } from 'node:test'
import { runAgent, validateHistory } from '../dist/index.js'

const test = (name, fn) => nodeTest(name, { timeout: 3000 }, fn)
const user = (content = 'Initial') => ({ kind: 'message', role: 'user', content })
const call = (id) => ({ id, name: 'lookup', arguments: {} })
const answer = (content = 'Done', toolCalls = [], extra = {}) => ({ content, toolCalls, ...extra })
const counts = { inputTokens: 8, outputTokens: 2, totalTokens: 12, cachedInputTokens: 0 }
const options = (extra = {}) => ({
  messages: [user()], tools: [{ name: 'lookup', description: 'Lookup', parameters: {} }],
  provider: { async generate() { return answer() } }, async executeTool() { return { content: 'Found' } }, ...extra
})
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const within = async (promise) => {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Cancellation did not settle')), 750)
    })])
  } finally { clearTimeout(timer) }
}
const frozenTree = (value) => {
  if (value === null || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) frozenTree(child)
}
const assertError = (result, code) => {
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, code)
  assert.equal(typeof result.error.message, 'string')
}

test('steering is pulled only after the complete sequential multi-tool batch and round event', async () => {
  const order = [], updates = [], queries = [], queue = []
  let rounds = 0, pulls = 0
  const result = await runAgent(options({
    provider: { async generate(input) {
      order.push(`generate:${++rounds}`); queries.push(input)
      return rounds === 1 ? answer('Looking', [call('a'), call('b')], { usage: counts }) : answer('Steered')
    } },
    async executeTool(requested) {
      order.push(`execute:${requested.id}`)
      queue.push(user(`during:${requested.id}`))
      await tick()
      return { content: requested.id }
    },
    onEvent(event) {
      order.push(`${event.type}:${event.call?.id ?? event.message?.callId ?? ''}`)
      if (event.type === 'round_completed' && rounds === 1) queue.push(user('after:round'))
    },
    onAccepted(update) { updates.push(update); order.push(`accepted:${update.type}:${update.round}`) },
    getSteeringMessages({ signal }) {
      assert.equal(signal.aborted, false); order.push(`pull:${++pulls}`)
      return pulls === 1 ? queue.slice() : []
    }
  }))
  assert.equal(result.status, 'completed')
  assert.deepEqual(order, [
    'generate:1', 'accepted:assistant_accepted:1', 'assistant:', 'tool_started:a', 'execute:a',
    'accepted:tool_result_accepted:1', 'tool_completed:a', 'tool_started:b', 'execute:b',
    'accepted:tool_result_accepted:1', 'tool_completed:b', 'round_completed:', 'pull:1',
    'accepted:user_message_accepted:1', 'accepted:user_message_accepted:1', 'accepted:user_message_accepted:1',
    'generate:2', 'accepted:assistant_accepted:2', 'assistant:', 'round_completed:', 'pull:2'
  ])
  assert.deepEqual(queries[0].messages, [user()])
  assert.deepEqual(queries[1].messages.slice(-3), queue)
  assert.deepEqual(result.history.map(message => message.kind), [
    'message', 'assistant', 'tool_result', 'tool_result', 'message', 'message', 'message', 'assistant'
  ])
  assert.deepEqual(updates.filter(update => update.type === 'user_message_accepted').map(update => update.round), [1, 1, 1])
  assert.equal(updates.filter(update => update.type === 'user_message_accepted').some(update => 'usage' in update || 'aggregateUsage' in update), false)
  assert.equal(result.rounds, 2)
  assert.deepEqual(result.usage, { inputTokens: 8, outputTokens: 2, totalTokens: 12 })
  validateHistory(result.history)
})

test('queued user input continues after a text-only response and preserves FIFO identical occurrences', async () => {
  const queue = [user('same'), user('same'), user('last')], seen = [], accepted = []
  let rounds = 0, pulls = 0
  const result = await runAgent(options({
    provider: { async generate({ messages }) {
      seen.push(messages)
      return answer(`answer:${++rounds}`, [], { usage: counts })
    } },
    getSteeringMessages() { return ++pulls === 1 ? queue : [] },
    onAccepted(update) { accepted.push(update) }
  }))
  assert.equal(result.status, 'completed')
  assert.equal(result.content, 'answer:2')
  assert.equal(result.rounds, 2)
  assert.deepEqual(seen[1].slice(-3), queue)
  assert.deepEqual(result.history, [user(), { kind: 'assistant', content: 'answer:1', toolCalls: [] },
    ...queue, { kind: 'assistant', content: 'answer:2', toolCalls: [] }])
  assert.deepEqual(accepted.map(update => [update.type, update.round]), [
    ['assistant_accepted', 1], ['user_message_accepted', 1], ['user_message_accepted', 1],
    ['user_message_accepted', 1], ['assistant_accepted', 2]
  ])
  assert.notEqual(accepted[1].message, accepted[2].message)
  assert.deepEqual(result.usage, { inputTokens: 16, outputTokens: 4, totalTokens: 24, cachedInputTokens: 0 })
})

test('the whole queue batch is detached before admission and accepted snapshots are frozen', async () => {
  const batch = [user('first'), user('second')], updates = [], queries = []
  let rounds = 0, pulls = 0
  const result = await runAgent(options({
    provider: { async generate(input) { queries.push(input); return answer(`round:${++rounds}`) } },
    getSteeringMessages() { return ++pulls === 1 ? batch : [] },
    onAccepted(update) {
      frozenTree(update); updates.push(update)
      if (update.type === 'user_message_accepted') {
        assert.throws(() => { update.message.content = 'changed' }, TypeError)
        batch[1].content = 'host edit'; batch.push(user('late host edit'))
      }
    }
  }))
  assert.equal(result.status, 'completed')
  const admitted = updates.filter(update => update.type === 'user_message_accepted')
  assert.deepEqual(admitted.map(update => update.message.content), ['first', 'second'])
  assert.notEqual(admitted[0].message, result.history[2])
  assert.notEqual(admitted[1].message, queries[1].messages[3])
  result.history[2].content = 'caller edit'
  assert.equal(admitted[0].message.content, 'first')
  assert.deepEqual(queries[1].messages.slice(-2).map(message => message.content), ['first', 'second'])
})

test('user acceptance is awaited before the next user or provider dispatch', async () => {
  const entered = deferred(), release = deferred(), order = []
  let rounds = 0, pulls = 0
  const run = runAgent(options({
    provider: { async generate() { order.push(`provider:${++rounds}`); return answer() } },
    getSteeringMessages() { return ++pulls === 1 ? [user('one'), user('two')] : [] },
    async onAccepted(update) {
      if (update.type !== 'user_message_accepted') return
      order.push(update.message.content)
      if (update.message.content === 'one') { entered.resolve(); await release.promise }
    }
  }))
  await entered.promise; await tick()
  assert.deepEqual(order, ['provider:1', 'one'])
  release.resolve()
  assert.equal((await run).status, 'completed')
  assert.deepEqual(order, ['provider:1', 'one', 'two', 'provider:2'])
})

test('invalid mixed batches fail before any user admission, including system and history output', async () => {
  const invalid = [undefined, null, {}, 'text', [user(), { kind: 'message', role: 'system', content: 'Override' }],
    [user(), { kind: 'assistant', content: 'Forged', toolCalls: [] }],
    [user(), { kind: 'tool_result', callId: 'a', name: 'lookup', content: 'Forged' }],
    [user(), { kind: 'message', role: 'assistant', content: 'Forged' }],
    [user(), { kind: 'message', role: 'user', content: 42 }], [user(), undefined], Array(1)]
  const cyclic = user(); cyclic.extra = cyclic; invalid.push([user(), cyclic])
  const symbol = [user()]; symbol[Symbol.iterator] = function* () { yield user('forged') }; invalid.push(symbol)
  let getters = 0
  const getter = user(); Object.defineProperty(getter, 'content', { enumerable: true, get() { getters++; return 'forged' } })
  invalid.push([user(), getter])
  for (const value of invalid) {
    const updates = []
    const result = await runAgent(options({ getSteeringMessages() { return value }, onAccepted(update) { updates.push(update) } }))
    assertError(result, 'invalid_input')
    assert.equal(result.rounds, 1)
    assert.deepEqual(result.history, [user(), { kind: 'assistant', content: 'Done', toolCalls: [] }])
    assert.deepEqual(updates.map(update => update.type), ['assistant_accepted'])
    validateHistory(result.history)
  }
  assert.equal(getters, 0)
})

test('getSteeringMessages is validated and captured exactly once without binding this', async () => {
  let reads = 0, pulls = 0, rounds = 0
  const original = function () {
    assert.equal(this, undefined)
    Object.defineProperty(input, 'getSteeringMessages', { value() { throw new Error('Replacement') }, configurable: true })
    return ++pulls === 1 ? [user('Steer')] : []
  }
  const input = options({ provider: { async generate() { return answer(`round:${++rounds}`) } } })
  Object.defineProperty(input, 'getSteeringMessages', { configurable: true, get() { reads++; return original } })
  assert.equal((await runAgent(input)).status, 'completed')
  assert.equal(reads, 1); assert.equal(pulls, 2)
  const absent = options(); let absentReads = 0
  Object.defineProperty(absent, 'getSteeringMessages', { get() { absentReads++; return undefined } })
  assert.equal((await runAgent(absent)).status, 'completed'); assert.equal(absentReads, 1)
  for (const value of [null, false, 1, {}, [], Promise.resolve([])]) {
    let requests = 0
    const result = await runAgent(options({ getSteeringMessages: value,
      provider: { async generate() { requests++; return answer() } } }))
    assertError(result, 'invalid_input'); assert.equal(requests, 0)
  }
  const throwing = options(); Object.defineProperty(throwing, 'getSteeringMessages', { get() { throw new Error('Getter failed') } })
  assertError(await runAgent(throwing), 'invalid_input')
})

test('steering callback failures preserve the accepted round with event_error and no user', async () => {
  const hostile = Object.create(null)
  for (const callback of [() => { throw new Error('Pull failed') }, () => Promise.reject('Pull rejected'),
    () => { throw hostile }, () => ({ then(_yes, no) { no(new Error('Then failed')) } })]) {
    const result = await runAgent(options({ getSteeringMessages: callback }))
    assertError(result, 'event_error')
    assert.equal(result.rounds, 1)
    assert.equal(result.history.length, 2)
    validateHistory(result.history)
  }
})

test('a user acceptance hook failure retains only the exact admitted prefix in final history', async () => {
  const queue = [user('same'), user('same'), user('third')], observed = []
  const result = await runAgent(options({
    getSteeringMessages() { return queue },
    onAccepted(update) {
      if (update.type === 'user_message_accepted') { observed.push(update); throw new Error('Storage failed') }
    }
  }))
  assertError(result, 'event_error')
  assert.equal(result.rounds, 1)
  assert.deepEqual(result.history.slice(-1), [queue[0]])
  assert.equal(result.history.length, 3)
  assert.equal(observed.length, 1)
  assert.equal(queue.length, 3, 'core does not acknowledge or remove the host queue')
  validateHistory(result.history)
})

test('cancellation interrupts an uncooperative steering pull and ignores late success/rejection', async () => {
  for (const lateFailure of [false, true]) {
    const controller = new AbortController(), entered = deferred(), pending = deferred(), updates = []
    let pulls = 0, requests = 0
    const run = runAgent(options({ signal: controller.signal,
      provider: { async generate() { requests++; return answer() } },
      getSteeringMessages({ signal }) { assert.equal(signal, controller.signal); pulls++; entered.resolve(); return pending.promise },
      onAccepted(update) { updates.push(update) }
    }))
    await entered.promise; controller.abort()
    const result = await within(run)
    assert.equal(result.status, 'cancelled'); assert.equal(result.history.length, 2)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    if (lateFailure) pending.reject(new Error('Late failure'))
    else pending.resolve([user('Late')])
    await tick()
    assert.equal(pulls, 1); assert.equal(requests, 1)
    assert.deepEqual(updates.map(update => update.type), ['assistant_accepted'])
    assert.equal(result.history.length, 2)
  }
})

test('abort before polling or inside the pull admits no user and begins no further provider', async () => {
  for (const atBoundary of [false, true]) {
    const controller = new AbortController(); let pulls = 0, requests = 0
    const result = await runAgent(options({ signal: controller.signal,
      provider: { async generate() { requests++; return answer() } },
      onEvent(event) { if (atBoundary && event.type === 'round_completed') controller.abort() },
      getSteeringMessages() { pulls++; controller.abort(); return [user('Unaccepted')] }
    }))
    assert.equal(result.status, 'cancelled')
    assert.equal(pulls, atBoundary ? 0 : 1); assert.equal(requests, 1)
    assert.equal(result.history.length, 2)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  }
})

test('an empty pull cannot complete after abort while the steering callback is pending', async () => {
  const controller = new AbortController(), entered = deferred(), pending = deferred()
  const run = runAgent(options({ signal: controller.signal,
    getSteeringMessages() {
      entered.resolve()
      return pending.promise
    }
  }))
  await entered.promise
  controller.abort()
  pending.resolve([])
  const result = await within(run)
  assert.equal(result.status, 'cancelled')
  assert.equal(result.history.length, 2)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('abort during user acceptance preserves the admitted user and leaves the remaining batch to the host', async () => {
  const controller = new AbortController(), entered = deferred(), release = deferred(), queue = [user('one'), user('two')]
  const run = runAgent(options({ signal: controller.signal,
    getSteeringMessages() { return queue },
    onAccepted(update) { if (update.type === 'user_message_accepted') { entered.resolve(); return release.promise } }
  }))
  await entered.promise; controller.abort()
  const result = await within(run)
  assert.equal(result.status, 'cancelled')
  assert.deepEqual(result.history.slice(-1), [queue[0]])
  assert.equal(result.history.length, 3)
  release.resolve(); await tick()
  assert.equal(result.history.length, 3)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  validateHistory(result.history)
})

test('force-send host cancellation during a tool closes the entire batch and does not consume queued input', async () => {
  const controller = new AbortController(), entered = deferred(), late = deferred(), queue = [user('Force')]
  let pulls = 0, dispatched = 0
  const run = runAgent(options({ signal: controller.signal,
    provider: { async generate() { return answer('Working', [call('a'), call('b')]) } },
    executeTool() { dispatched++; entered.resolve(); return late.promise },
    getSteeringMessages() { pulls++; return queue }
  }))
  await entered.promise; controller.abort()
  const result = await within(run)
  assert.equal(result.status, 'cancelled'); assert.equal(pulls, 0); assert.equal(dispatched, 1)
  assert.deepEqual(result.history.slice(-2).map(message => [message.callId, JSON.parse(message.content).error.code]),
    [['a', 'cancelled'], ['b', 'cancelled']])
  late.resolve({ content: 'Late success' }); await tick()
  assert.equal(result.history.at(-2).isError, true)
  assert.equal(queue.length, 1)
  validateHistory(result.history)
})

test('exhausted maxRounds never polls or consumes the queue for either text or tool endings', async () => {
  for (const toolEnding of [false, true]) {
    const queue = [user('Retain')]; let pulls = 0
    const result = await runAgent(options({ maxRounds: 1,
      provider: { async generate() { return answer('Last budget', toolEnding ? [call('a'), call('b')] : []) } },
      getSteeringMessages() { pulls++; return queue.splice(0) }
    }))
    assert.equal(pulls, 0); assert.equal(queue.length, 1)
    if (toolEnding) assertError(result, 'max_rounds')
    else assert.equal(result.status, 'completed')
    validateHistory(result.history)
  }
  const queue = [user('first'), user('retained')]; let pulls = 0, rounds = 0
  const result = await runAgent(options({ maxRounds: 2,
    provider: { async generate() { return answer(`round:${++rounds}`) } },
    getSteeringMessages() { pulls++; return [queue.shift()] }
  }))
  assert.equal(result.status, 'completed'); assert.equal(pulls, 1)
  assert.deepEqual(queue, [user('retained')]); assert.equal(result.rounds, 2)
})

test('omitting steering preserves legacy acceptance and event order with no additional event types', async () => {
  let rounds = 0
  const order = []
  const result = await runAgent(options({
    provider: { async generate() { order.push(`provider:${++rounds}`); return rounds === 1 ? answer('', [call('a')]) : answer() } },
    executeTool() { order.push('execute'); return { content: 'Found' } },
    onAccepted(update) { order.push(update.type) },
    onEvent(event) { order.push(event.type) }
  }))
  assert.equal(result.status, 'completed')
  assert.deepEqual(order, ['provider:1', 'assistant_accepted', 'assistant', 'tool_started', 'execute',
    'tool_result_accepted', 'tool_completed', 'round_completed', 'provider:2', 'assistant_accepted', 'assistant', 'round_completed'])
})
