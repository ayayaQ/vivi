// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { test } from 'node:test'
import { runAgent } from '../dist/index.js'
import { createExtensionScope, createToolRegistry } from '../dist/extensions.js'
import { createQuestionExtension } from '../dist/extensions/questions.js'

// Offline callbacks only. These tests exercise the portable extension contract,
// not a production CLI, native dialog, external service, or approval mechanism.
const clone = value => structuredClone(value)
const signal = () => new AbortController().signal
const context = () => ({ signal: signal() })
const question = (overrides = {}) => ({
  id: 'format', header: 'Format', question: 'Which format should I use?',
  options: [{ id: 'brief', label: 'Brief', description: 'A short summary' },
    { id: 'full', label: 'Full' }], ...overrides
})
const args = (questions = [question()]) => ({ questions })
const call = (id = 'call-1', arguments_ = args()) => ({ id, name: 'request_user_input', arguments: arguments_ })
const answered = (request, answers = request.questions.map(item => ({ id: item.id, answer: { kind: 'skipped' } }))) =>
  ({ requestId: request.requestId, status: 'answered', answers })
const parse = result => {
  assert.notEqual(result.isError, true, result.content)
  return JSON.parse(result.content)
}
const errorCode = result => {
  assert.equal(result.isError, true)
  return JSON.parse(result.content).error.code
}
const subject = ask => {
  const extension = createQuestionExtension({ ask })
  return { extension, registry: createToolRegistry([extension]) }
}
const gate = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
async function promptly(promise) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Question operation did not settle promptly')), 1000)
    })])
  } finally { clearTimeout(timer) }
}
function assertFrozenTree(value) {
  if (value === null || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true)
  for (const item of Object.values(value)) assertFrozenTree(item)
}

test('question capability is advertised only when the host supplies an ask callback', async () => {
  for (const extension of [createQuestionExtension(), createQuestionExtension({})]) {
    assert.equal(extension.id, 'vivi.questions')
    assert.equal(extension.apiVersion, 1)
    assert.deepEqual(extension.tools, [])
    const registry = createToolRegistry([extension])
    assert.deepEqual(registry.tools, [])
    assert.equal(registry.has('request_user_input'), false)
    assert.equal(errorCode(await registry.executeTool(call(), context())), 'unavailable_tool')
  }
  const { extension, registry } = subject(request => answered(request))
  assert.equal(extension.id, 'vivi.questions')
  assert.equal(extension.apiVersion, 1)
  assert.deepEqual(registry.tools.map(tool => tool.name), ['request_user_input'])
  assert.equal(registry.tools[0].parameters.type, 'object')
  assertFrozenTree(registry.tools)
  assert.throws(() => createToolRegistry([extension, extension]), /Duplicate extension id/)
  assert.throws(() => createToolRegistry([extension], { reservedNames: ['request_user_input'] }), /collision/)
})

test('bounded questions accept one through three questions and two or three optional choices', async () => {
  const observed = []
  const { registry } = subject(request => { observed.push(request); return answered(request) })
  for (const size of [1, 2, 3]) {
    const questions = Array.from({ length: size }, (_, index) => {
      const item = question({ id: `question_${index}` })
      if (index === 0) delete item.options
      if (index === 2) item.options.push({ id: 'third', label: 'Third' })
      return item
    })
    assert.equal(parse(await registry.executeTool(call(`size-${size}`, args(questions)), context())).status, 'answered')
    assert.deepEqual(observed.at(-1).questions, questions)
  }
  const boundary = question({ id: 'q'.repeat(64), header: 'h'.repeat(24), question: 'x'.repeat(1000),
    options: [{ id: 'o'.repeat(64), label: 'l'.repeat(100), description: 'd'.repeat(500) },
      { id: '_-Az09', label: 'Second' }] })
  assert.equal(parse(await registry.executeTool(call('maximums', args([boundary])), context())).status, 'answered')
  // Option identities belong to their own question, not a global choice namespace.
  assert.equal(parse(await registry.executeTool(call('reused-options', args([
    question({ id: 'one' }), question({ id: 'two' })
  ])), context())).status, 'answered')
})

test('invalid JSON arguments are invalid_arguments and never invoke the host', async () => {
  let invocations = 0
  const { registry } = subject(request => { invocations++; return answered(request) })
  const bad = [
    {}, { questions: null }, { questions: {} }, args([]), args(Array.from({ length: 4 }, (_, i) => question({ id: `q${i}` }))),
    { ...args(), unexpected: true }, args([null]), args([{}]), args([[]]),
    args([question(), question()]),
    ...['', 'q q', 'q.q', ' q', 'q ', 'x'.repeat(65), '中文', 1, null].map(id => args([question({ id })])),
    ...['', ' ', 'h'.repeat(25), 1, null].map(header => args([question({ header })])),
    ...['', ' \n ', 'x'.repeat(1001), 1, null].map(text => args([question({ question: text })])),
    args([question({ unexpected: true })]), args([question({ options: null })]), args([question({ options: {} })]),
    args([question({ options: [] })]), args([question({ options: [{ id: 'one', label: 'Only' }] })]),
    args([question({ options: Array.from({ length: 4 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` })) })]),
    args([question({ options: [{ id: 'one', label: 'One' }, { id: 'one', label: 'Two' }] })]),
    args([question({ options: [{ id: 'one', label: 'Same' }, { id: 'two', label: ' Same ' }] })]),
    ...[null, [], {}, { id: 'one' }, { label: 'One' }, { id: 'one', label: 'One', unexpected: true }]
      .map(option => args([question({ options: [option, { id: 'two', label: 'Two' }] })])),
    ...['', 'o o', 'o.o', ' o', 'o ', 'x'.repeat(65), '中文', 1, null]
      .map(id => args([question({ options: [{ id, label: 'One' }, { id: 'two', label: 'Two' }] })])),
    ...['', ' ', 'l'.repeat(101), 1, null]
      .map(label => args([question({ options: [{ id: 'one', label }, { id: 'two', label: 'Two' }] })])),
    ...['', ' ', 'd'.repeat(501), 1, null]
      .map(description => args([question({ options: [{ id: 'one', label: 'One', description }, { id: 'two', label: 'Two' }] })]))
  ]
  for (const arguments_ of bad) {
    assert.equal(errorCode(await registry.executeTool(call('invalid', arguments_), context())), 'invalid_arguments', JSON.stringify(arguments_))
  }
  assert.equal(invocations, 0)
})

test('malformed JavaScript arguments fail before extension callbacks or accessor reads', async () => {
  let invocations = 0, accessorReads = 0
  const { registry } = subject(request => { invocations++; return answered(request) })
  const getterQuestion = Object.defineProperty(question(), 'question', {
    enumerable: true, get() { accessorReads++; return 'Do not read me' }
  })
  const cyclic = args(); cyclic.questions[0].cycle = cyclic
  const symbol = args(); symbol[Symbol('hidden')] = true
  for (const arguments_ of [args(new Array(1)), args([getterQuestion]), cyclic, symbol,
    args([question({ options: new Array(2) })]), args([question({ extra: undefined })])]) {
    await assert.rejects(registry.executeTool(call('malformed', arguments_), context()))
  }
  assert.equal(invocations, 0)
  assert.equal(accessorReads, 0)
})

test('host requests are deeply frozen detached snapshots bound to the active call', async () => {
  const entered = gate(), release = gate()
  let received, callbackSignal
  const { registry } = subject(async (request, { signal }) => {
    received = request; callbackSignal = signal; entered.resolve()
    await release.promise
    return answered(request)
  })
  const input = call('captured-call')
  const controller = new AbortController()
  const pending = registry.executeTool(input, { signal: controller.signal })
  await promptly(entered.promise)
  assertFrozenTree(received)
  assert.match(received.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  assert.equal(received.callId, 'captured-call')
  assert(callbackSignal instanceof AbortSignal)
  assert.equal(callbackSignal.aborted, false)
  assert.deepEqual(received.questions, input.arguments.questions)
  assert.equal(Object.isFrozen(input.arguments), false)
  input.id = 'changed-call'
  input.arguments.questions[0].options[0].label = 'Changed'
  input.arguments.questions.length = 0
  assert.equal(received.callId, 'captured-call')
  assert.equal(received.questions[0].options[0].label, 'Brief')
  assert.throws(() => { received.questions[0].question = 'Changed' }, TypeError)
  release.resolve()
  assert.equal(parse(await promptly(pending)).requestId, received.requestId)
})

test('option, free-text and skip are available together without synthetic choice rows', async () => {
  let observed
  const { registry } = subject(request => {
    observed = request
    return answered(request, [
      { id: 'choice', answer: { kind: 'option', optionId: 'full' } },
      { id: 'text', answer: { kind: 'text', text: '  A custom answer\nwith formatting  ' } },
      { id: 'skip', answer: { kind: 'skipped' } }
    ])
  })
  const questions = [question({ id: 'choice' }), question({ id: 'text' }), question({ id: 'skip' })]
  const output = parse(await registry.executeTool(call('mixed', args(questions)), context()))
  assert.deepEqual(observed.questions, questions)
  assert.deepEqual(output.answers, [
    { id: 'choice', answer: { kind: 'option', optionId: 'full' } },
    { id: 'text', answer: { kind: 'text', text: '  A custom answer\nwith formatting  ' } },
    { id: 'skip', answer: { kind: 'skipped' } }
  ])
  assert.equal(observed.questions.every(item => item.options.length === 2), true)
})

test('questions without choices support text and skip, including the text length boundary', async () => {
  let nextAnswer = { kind: 'text', text: 'x'.repeat(4000) }
  const { registry } = subject(request => answered(request, [{ id: 'format', answer: nextAnswer }]))
  const item = question(); delete item.options
  assert.equal(parse(await registry.executeTool(call('text-max', args([item])), context())).answers[0].answer.text.length, 4000)
  nextAnswer = { kind: 'skipped' }
  assert.deepEqual(parse(await registry.executeTool(call('skip-no-choices', args([item])), context())).answers[0].answer, nextAnswer)
})

test('dialog cancellation is a bounded host response, distinct from aborting a run', async () => {
  const controller = new AbortController()
  const { registry } = subject(request => ({ requestId: request.requestId, status: 'cancelled' }))
  const output = parse(await registry.executeTool(call(), { signal: controller.signal }))
  assert.equal(output.status, 'cancelled')
  assert.equal(Object.hasOwn(output, 'answers'), false)
  assert.equal(controller.signal.aborted, false)
})

test('factory rejects malformed callbacks and captures the original host function', async () => {
  for (const options of [null, [], { ask: null }, { ask: true }, { ask: 'ask' }, { ask: {} }, { unexpected: true }]) {
    assert.throws(() => createQuestionExtension(options))
  }
  const options = { ask: request => answered(request) }
  const extension = createQuestionExtension(options)
  options.ask = () => { throw new Error('Replacement callback must not run') }
  assertFrozenTree(extension)
  assert.equal(parse(await createToolRegistry([extension]).executeTool(call(), context())).status, 'answered')
})

test('answer order is canonicalized to question order and host ownership stays detached', async () => {
  let response
  const { registry } = subject(request => {
    response = answered(request, [
      { id: 'second', answer: { kind: 'text', text: 'Second answer' } },
      { id: 'first', answer: { kind: 'option', optionId: 'brief' } }
    ])
    return response
  })
  const result = await registry.executeTool(call('ordered', args([question({ id: 'first' }), question({ id: 'second' })])), context())
  const expected = { requestId: response.requestId, status: 'answered', answers: [
    { id: 'first', answer: { kind: 'option', optionId: 'brief' } },
    { id: 'second', answer: { kind: 'text', text: 'Second answer' } }
  ] }
  assert.deepEqual(parse(result), expected)
  response.answers[0].answer.text = 'Late host edit'
  response.answers.length = 0
  response.status = 'cancelled'
  assert.deepEqual(parse(result), expected)
  assert.equal(Object.isFrozen(response), false)
})

test('malformed host responses become tool_error without accepting partial or invented answers', async () => {
  const bad = [
    () => null, () => [], () => 'answered', () => ({}),
    request => ({ ...answered(request), requestId: 'stale-request' }),
    request => ({ ...answered(request), requestId: request.callId }),
    request => ({ ...answered(request), status: 'approved' }),
    request => ({ ...answered(request), approved: true }),
    request => ({ ...answered(request), callId: request.callId }),
    request => ({ requestId: request.requestId, status: 'answered' }),
    request => ({ ...answered(request), answers: null }),
    request => ({ ...answered(request), answers: {} }),
    request => answered(request, []),
    request => answered(request, [null, { id: 'second', answer: { kind: 'skipped' } }]),
    request => answered(request, [{ id: 'format', answer: { kind: 'skipped' } }, { id: 'format', answer: { kind: 'skipped' } }]),
    request => answered(request, [{ id: 'unknown', answer: { kind: 'skipped' } }, { id: 'second', answer: { kind: 'skipped' } }]),
    request => answered(request, [{ id: 'FORMAT', answer: { kind: 'skipped' } }, { id: 'second', answer: { kind: 'skipped' } }]),
    request => ({ requestId: request.requestId, status: 'cancelled', answers: [] }),
    request => ({ requestId: request.requestId, status: 'cancelled', approved: true }),
    ...[null, [], {}, { kind: 'other' }, { kind: 'option' }, { kind: 'option', optionId: 'unknown' },
      { kind: 'option', optionId: 'BRIEF' }, { kind: 'option', optionId: 1 },
      { kind: 'option', optionId: 'brief', text: 'Extra' },
      { kind: 'text' }, { kind: 'text', text: '' }, { kind: 'text', text: ' \n ' },
      { kind: 'text', text: 'x'.repeat(4001) }, { kind: 'text', text: 1 },
      { kind: 'text', text: 'Okay', optionId: 'brief' }, { kind: 'skipped', text: 'Extra' }]
      .map(answer => request => answered(request, [{ id: 'format', answer }, { id: 'second', answer: { kind: 'skipped' } }])),
    request => answered(request, [{ id: 'format', answer: { kind: 'skipped' }, extra: true },
      { id: 'second', answer: { kind: 'skipped' } }]),
    request => answered(request, [{ answer: { kind: 'skipped' } }, { id: 'second', answer: { kind: 'skipped' } }]),
    request => answered(request, [{ id: 'format' }, { id: 'second', answer: { kind: 'skipped' } }])
  ]
  for (const [index, respond] of bad.entries()) {
    const { registry } = subject(respond)
    const result = await registry.executeTool(call(`bad-host-${index}`, args([question(), question({ id: 'second' })])), context())
    assert.equal(errorCode(result), 'tool_error', `host response case ${index}`)
  }
  const noOptions = question(); delete noOptions.options
  const { registry } = subject(request => answered(request, [{ id: 'format', answer: { kind: 'option', optionId: 'brief' } }]))
  assert.equal(errorCode(await registry.executeTool(call('no-options', args([noOptions])), context())), 'tool_error')
})

test('non-JSON host data is rejected without running accessors', async () => {
  let reads = 0
  const { registry } = subject(request => Object.defineProperty(answered(request), 'status', {
    enumerable: true, get() { reads++; return 'answered' }
  }))
  assert.equal(errorCode(await registry.executeTool(call(), context())), 'tool_error')
  assert.equal(reads, 0)
  for (const respond of [
    request => ({ ...answered(request), answers: new Array(1) }),
    request => ({ ...answered(request), answers: [{ id: 'format', answer: { kind: 'skipped', extra: undefined } }] }),
    request => { const result = answered(request); result.answers[0].answer.extra = result; return result },
    request => { const result = answered(request); result[Symbol('extra')] = true; return result },
    () => new Date()
  ]) {
    const { registry: invalid } = subject(respond)
    assert.equal(errorCode(await invalid.executeTool(call(), context())), 'tool_error')
  }
})

test('each dispatch has a new UUID even when a host reuses a call id', async () => {
  const requests = []
  const { registry } = subject(request => { requests.push(request); return answered(request) })
  for (let index = 0; index < 4; index++) await registry.executeTool(call('reused'), context())
  assert.equal(new Set(requests.map(request => request.requestId)).size, 4)
  assert.deepEqual(requests.map(request => request.callId), ['reused', 'reused', 'reused', 'reused'])
  for (const request of requests) assert.match(request.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
})

test('stale response cannot answer a later dispatch with the same call id', async () => {
  let oldResponse, dispatches = 0
  const { registry } = subject(request => {
    if (++dispatches === 1) { oldResponse = answered(request); return oldResponse }
    return oldResponse
  })
  assert.equal(parse(await registry.executeTool(call('same'), context())).status, 'answered')
  assert.equal(errorCode(await registry.executeTool(call('same'), context())), 'tool_error')
})

test('a shared extension serializes host prompts in FIFO order across registries', async () => {
  const releases = [gate(), gate(), gate()], entries = [gate(), gate(), gate()], observed = []
  let active = 0, maximum = 0
  const { extension } = subject(async request => {
    const index = observed.length
    observed.push(request.callId); active++; maximum = Math.max(maximum, active); entries[index].resolve()
    await releases[index].promise
    active--
    return answered(request)
  })
  const firstRegistry = createToolRegistry([extension]), secondRegistry = createToolRegistry([extension])
  const first = firstRegistry.executeTool(call('first'), context())
  await promptly(entries[0].promise)
  const second = secondRegistry.executeTool(call('second'), context())
  const third = firstRegistry.executeTool(call('third'), context())
  await tick()
  assert.deepEqual(observed, ['first'])
  releases[0].resolve()
  assert.equal(parse(await promptly(first)).status, 'answered')
  await promptly(entries[1].promise)
  assert.deepEqual(observed, ['first', 'second'])
  releases[1].resolve()
  await promptly(second); await promptly(entries[2].promise)
  releases[2].resolve()
  await promptly(third)
  assert.deepEqual(observed, ['first', 'second', 'third'])
  assert.equal(maximum, 1)
})

test('independent extension instances do not impose an unintended global host queue', async () => {
  const entered = [gate(), gate()], release = gate()
  const registries = entered.map(ready => subject(async request => {
    ready.resolve(); await release.promise; return answered(request)
  }).registry)
  const operations = registries.map((registry, index) => registry.executeTool(call(`independent-${index}`), context()))
  await promptly(Promise.all(entered.map(ready => ready.promise)))
  release.resolve()
  for (const result of await promptly(Promise.all(operations))) assert.equal(parse(result).status, 'answered')
})

test('host exceptions and malformed or cancelled responses release the queue', async () => {
  for (const fail of [() => { throw new Error('Synchronous host failure') },
    async () => { throw new Error('Asynchronous host failure') },
    request => ({ requestId: request.requestId, status: 'wrong' }),
    request => ({ requestId: request.requestId, status: 'cancelled' })]) {
    let invocations = 0
    const { registry } = subject(request => ++invocations === 1 ? fail(request) : answered(request))
    const first = registry.executeTool(call('first'), context())
    const next = registry.executeTool(call('next'), context())
    const initial = await promptly(first)
    if (JSON.parse(initial.content).status !== 'cancelled') assert.equal(errorCode(initial), 'tool_error')
    assert.equal(parse(await promptly(next)).status, 'answered')
    assert.equal(invocations, 2)
  }
})

test('pre-aborted run never opens a prompt or consumes a queue slot', async () => {
  const before = new AbortController(), reason = new Error('Stopped before dispatch')
  before.abort(reason)
  let invocations = 0
  const { registry } = subject(request => { invocations++; return answered(request) })
  await assert.rejects(registry.executeTool(call('aborted'), { signal: before.signal }), error => error === reason)
  assert.equal(invocations, 0)
  assert.equal(parse(await promptly(registry.executeTool(call('next'), context()))).status, 'answered')
})

test('abort in the admission microtask prevents the host callback', async () => {
  const controller = new AbortController()
  let invocations = 0
  const { registry } = subject(request => { invocations++; return answered(request) })
  const operation = registry.executeTool(call(), { signal: controller.signal })
  const rejected = assert.rejects(operation, { name: 'AbortError' })
  controller.abort()
  await promptly(rejected)
  await tick()
  assert.equal(invocations, 0)
})

for (const late of ['resolve', 'reject']) test(`active abort settles promptly and ignores late host ${late}`, async () => {
  const controller = new AbortController(), entered = gate(), host = gate(), observed = []
  let oldRequest, hostSignal
  const { registry } = subject((request, { signal }) => {
    observed.push(request.callId)
    if (observed.length > 1) return answered(request)
    oldRequest = request; hostSignal = signal; entered.resolve(); return host.promise
  })
  const operation = registry.executeTool(call('old'), { signal: controller.signal })
  const cancelled = assert.rejects(operation, { name: 'AbortError' })
  await promptly(entered.promise)
  controller.abort()
  await promptly(cancelled)
  assert.equal(hostSignal.aborted, true)
  const result = parse(await promptly(registry.executeTool(call('next'), context())))
  assert.notEqual(result.requestId, oldRequest.requestId)
  if (late === 'resolve') host.resolve(answered(oldRequest, [{ id: 'format', answer: { kind: 'text', text: 'Obsolete answer' } }]))
  else host.reject(new Error('Obsolete host failure'))
  await tick(); await tick()
  assert.deepEqual(observed, ['old', 'next'])
  assert.equal(JSON.stringify(result).includes('Obsolete'), false)
})

test('queued abort is prompt and concurrent aborted waiters never reserve the queue forever', async () => {
  const entered = gate(), release = gate(), requests = []
  const { registry } = subject(async request => {
    requests.push(request)
    if (requests.length === 1) { entered.resolve(); await release.promise }
    return answered(request)
  })
  const active = registry.executeTool(call('active'), context())
  await promptly(entered.promise)
  const controllers = Array.from({ length: 4 }, () => new AbortController())
  const queued = controllers.map((controller, index) => registry.executeTool(call(`aborted-${index}`), { signal: controller.signal }))
  const rejected = queued.map(operation => assert.rejects(operation, { name: 'AbortError' }))
  const remaining = registry.executeTool(call('remaining'), context())
  for (const controller of controllers) controller.abort()
  await promptly(Promise.all(rejected))
  assert.deepEqual(requests.map(request => request.callId), ['active'])
  release.resolve()
  await promptly(active)
  assert.equal(parse(await promptly(remaining)).status, 'answered')
  assert.deepEqual(requests.map(request => request.callId), ['active', 'remaining'])
})

test('active and queued cancellation together allow a later caller to make progress', async () => {
  const entered = gate(), host = gate(), requests = []
  const { registry } = subject(request => {
    requests.push(request)
    if (requests.length === 1) { entered.resolve(); return host.promise }
    return answered(request)
  })
  const activeController = new AbortController(), queuedController = new AbortController()
  const active = registry.executeTool(call('active'), { signal: activeController.signal })
  const activeRejected = assert.rejects(active, { name: 'AbortError' })
  await promptly(entered.promise)
  const queued = registry.executeTool(call('queued'), { signal: queuedController.signal })
  const queuedRejected = assert.rejects(queued, { name: 'AbortError' })
  const next = registry.executeTool(call('next'), context())
  queuedController.abort(); activeController.abort()
  await promptly(Promise.all([activeRejected, queuedRejected]))
  assert.equal(parse(await promptly(next)).status, 'answered')
  host.resolve(answered(requests[0])); await tick()
  assert.deepEqual(requests.map(request => request.callId), ['active', 'next'])
})

test('abort after a synchronous host response cannot accept that response', async () => {
  const controller = new AbortController()
  const { registry } = subject(request => {
    controller.abort(new Error('Cancelled at response boundary'))
    return answered(request)
  })
  await assert.rejects(promptly(registry.executeTool(call(), { signal: controller.signal })), /Cancelled at response boundary/)
})

test('success, failure and abort release their run-signal listeners', async () => {
  for (const mode of ['success', 'failure', 'abort']) {
    const controller = new AbortController(), entered = gate(), host = gate()
    const original = getEventListeners(controller.signal, 'abort').length
    const { registry } = subject(request => {
      if (mode === 'failure') throw new Error('Synthetic callback failure')
      if (mode === 'success') return answered(request)
      entered.resolve(); return host.promise
    })
    const operation = registry.executeTool(call(), { signal: controller.signal })
    if (mode === 'abort') {
      const rejected = assert.rejects(operation, { name: 'AbortError' })
      await promptly(entered.promise); controller.abort(); await promptly(rejected)
    } else await promptly(operation)
    await tick()
    assert.equal(getEventListeners(controller.signal, 'abort').length, original)
  }
})

test('scope disposal cancels both active and queued prompts and retained snapshots cannot reopen them', async t => {
  const scope = createExtensionScope(), entered = gate(), host = gate(), requests = []
  let hostSignal
  scope.register(createQuestionExtension({ ask(request, { signal }) {
    requests.push(request); hostSignal = signal; entered.resolve(); return host.promise
  } }))
  const registry = scope.snapshot()
  t.after(() => scope.dispose())
  const active = registry.executeTool(call('active'), context())
  const activeRejected = assert.rejects(active, { name: 'AbortError' })
  await promptly(entered.promise)
  const queued = registry.executeTool(call('queued'), context())
  const queuedRejected = assert.rejects(queued, { name: 'AbortError' })
  await promptly(scope.dispose())
  await promptly(Promise.all([activeRejected, queuedRejected]))
  assert.equal(hostSignal.aborted, true)
  assert.equal(scope.state, 'closed')
  await assert.rejects(registry.executeTool(call('retained'), context()), { name: 'AbortError' })
  host.resolve(answered(requests[0])); await tick()
  assert.deepEqual(requests.map(request => request.callId), ['active'])
})

test('current run cancellation leaves its owner open for a fresh run', async t => {
  const scope = createExtensionScope(), controller = new AbortController(), entered = gate(), late = gate(), requests = []
  scope.register(createQuestionExtension({ ask(request) {
    requests.push(request)
    if (requests.length === 1) { entered.resolve(); return late.promise }
    return answered(request)
  } }))
  t.after(() => scope.dispose())
  const registry = scope.snapshot(), operation = registry.executeTool(call('reused'), { signal: controller.signal })
  const rejected = assert.rejects(operation, { name: 'AbortError' })
  await promptly(entered.promise); controller.abort(); await promptly(rejected)
  assert.equal(scope.state, 'open')
  assert.equal(scope.signal.aborted, false)
  const next = parse(await promptly(registry.executeTool(call('reused'), context())))
  assert.notEqual(next.requestId, requests[0].requestId)
  late.resolve(answered(requests[0])); await tick()
  assert.equal(requests.length, 2)
})

test('runAgent cancellation closes question history without recording ignored late input', async () => {
  const controller = new AbortController(), entered = gate(), host = gate()
  let received
  const { registry } = subject(request => { received = request; entered.resolve(); return host.promise })
  const events = []
  const running = runAgent({ provider: { async generate() { return { content: '', toolCalls: [call()] } } },
    messages: [], tools: registry.tools, executeTool: registry.executeTool, signal: controller.signal,
    onEvent(event) { events.push(clone(event)) } })
  await promptly(entered.promise); controller.abort()
  const result = await promptly(running)
  assert.equal(result.status, 'cancelled')
  const closure = result.history.find(item => item.kind === 'tool_result')
  assert.equal(closure.callId, 'call-1')
  assert.equal(errorCode(closure), 'cancelled')
  const history = clone(result.history), beforeEvents = clone(events)
  host.resolve(answered(received, [{ id: 'format', answer: { kind: 'text', text: 'Late human input' } }]))
  await tick(); await tick()
  assert.deepEqual(result.history, history)
  assert.deepEqual(events, beforeEvents)
  assert.equal(JSON.stringify(result.history).includes('Late human input'), false)
})
