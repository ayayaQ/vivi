// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { test } from 'node:test'
import { runAgent } from '../dist/index.js'
import { createExtensionScope } from '../dist/extensions.js'

const context = () => ({ signal: new AbortController().signal })
const call = (name = 'fixture', arguments_ = {}) => ({ id: 'call-1', name, arguments: arguments_ })
const extension = (id = 'fixture', name = id, overrides = {}) => ({ id, apiVersion: 1, tools: [{
  definition: { name, description: 'Fixture', parameters: { type: 'object' } },
  validateArguments() {}, execute() { return { content: name } }, ...overrides
}] })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const errorCode = result => { assert.equal(result.isError, true); return JSON.parse(result.content).error.code }

test('scope validates and captures reservations including disabled host names once', async () => {
  for (const options of [null, [], { reservedNames: null }, { reservedNames: [''] },
    { reservedNames: new Array(1) }, Object.defineProperty({}, 'reservedNames', {
      enumerable: true, get() { throw new Error('Getter must not run') }
    })]) assert.throws(() => createExtensionScope(options))
  const reservedNames = ['disabled_host']
  const options = { reservedNames }
  const scope = createExtensionScope(options)
  reservedNames.length = 0
  options.reservedNames = ['fixture']
  assert.equal(Object.isFrozen(scope), true)
  assert.equal(scope.state, 'open')
  assert.equal(scope.signal.aborted, false)
  assert.throws(() => scope.register(extension('collision', 'disabled_host')), /collision/)
  scope.register(extension())
  assert.deepEqual(scope.snapshot().tools.map(tool => tool.name), ['fixture'])
  await scope.dispose()
})

test('registration publishes the whole valid candidate or nothing and preserves prior tools', async () => {
  const scope = createExtensionScope()
  scope.register(extension('prior'))
  const candidate = extension('candidate', 'first')
  candidate.tools.push(...extension('other', 'invalid', { execute: null }).tools)
  assert.throws(() => scope.register(candidate), /execute/)
  assert.deepEqual(scope.snapshot().tools.map(tool => tool.name), ['prior'])
  candidate.tools.pop()
  scope.register(candidate)
  assert.throws(() => scope.register(extension('candidate', 'different')), /Duplicate extension id/)
  assert.throws(() => scope.register(extension('collision', 'prior')), /collision/)
  assert.deepEqual(scope.snapshot().tools.map(tool => tool.name), ['prior', 'first'])
  await scope.dispose()
})

test('empty extensions retain identity and invalid contracts never publish', async () => {
  const scope = createExtensionScope()
  scope.register({ id: 'empty', apiVersion: 1, tools: [] })
  assert.throws(() => scope.register({ id: 'empty', apiVersion: 1, tools: [] }), /Duplicate/)
  for (const candidate of [null, {}, { ...extension(), apiVersion: 2 },
    { ...extension(), tools: [null] }, { ...extension(), id: ' spaced ' },
    extension('invalid', 'bad', { definition: { name: 'bad', description: '', parameters: [] } })]) {
    assert.throws(() => scope.register(candidate))
    assert.deepEqual(scope.snapshot().tools, [])
  }
  await scope.dispose()
})

test('snapshots capture frozen definitions/functions and never acquire later registrations', async () => {
  let validations = 0
  const source = extension('first', 'first', { validateArguments() { validations++ } })
  const scope = createExtensionScope()
  scope.register(source)
  const before = scope.snapshot()
  source.id = 'changed'
  source.tools[0].definition.name = 'changed'
  source.tools[0].definition.parameters.type = 'array'
  source.tools[0].validateArguments = () => { throw new Error('Changed') }
  source.tools[0].execute = () => ({ content: 'changed' })
  source.tools.length = 0
  scope.register(extension('second'))
  const after = scope.snapshot()
  assert.equal(Object.isFrozen(source), false)
  assert.equal(Object.isFrozen(before), true)
  assert.equal(Object.isFrozen(before.tools), true)
  assert.equal(Object.isFrozen(before.tools[0].parameters), true)
  assert.throws(() => { before.tools[0].parameters.type = 'array' }, TypeError)
  assert.deepEqual(before.tools.map(tool => tool.name), ['first'])
  assert.deepEqual(after.tools.map(tool => tool.name), ['first', 'second'])
  assert.equal(before.has('second'), false)
  assert.equal(errorCode(await before.executeTool(call('second'), context())), 'unavailable_tool')
  assert.equal((await before.executeTool(call('first'), context())).content, 'first')
  assert.equal(validations, 1)
  await scope.dispose()
  assert.deepEqual(before.tools.map(tool => tool.name), ['first'])
  assert.equal(before.has('first'), true)
  await assert.rejects(before.executeTool(call('first'), context()), { name: 'AbortError' })
})

test('scope preserves static validation, detached ownership and error behavior', async () => {
  const scope = createExtensionScope()
  let captured, executions = 0, accessorReads = 0
  const output = { content: 'original' }
  scope.register(extension('fixture', 'fixture', {
    validateArguments(arguments_) {
      assert.equal(this, undefined)
      assert.equal(Object.isFrozen(arguments_.nested), true)
      captured = arguments_
      if (arguments_.nested.value !== 1) throw new Error('Bad value')
    }, execute(received, receivedContext) {
      assert.equal(this, undefined)
      assert.equal(received.arguments, captured)
      assert.equal(Object.isFrozen(receivedContext), true)
      executions++
      return output
    }
  }))
  const registry = scope.snapshot()
  for (const malformed of [null, {}, call('', {}), call('fixture', []), call('fixture', { bad: undefined }),
    Object.defineProperty(call(), 'name', { enumerable: true, get() { accessorReads++; return 'fixture' } })]) {
    await assert.rejects(registry.executeTool(malformed, context()))
  }
  await assert.rejects(registry.executeTool(call(), {}), /AbortSignal/)
  assert.equal(executions, 0)
  assert.equal(accessorReads, 0)
  const input = call('fixture', { nested: { value: 1 } })
  const result = await registry.executeTool(input, context())
  input.arguments.nested.value = 2
  output.content = 'changed'
  assert.equal(captured.nested.value, 1)
  assert.equal(result.content, 'original')
  assert.equal(errorCode(await registry.executeTool(call('fixture', { nested: { value: 2 } }), context())), 'invalid_arguments')
  await scope.dispose()
})

test('dispose seals synchronously, shares completion under concurrency/reentrancy and awaits reverse cleanup', async () => {
  const scope = createExtensionScope()
  const gate = deferred(), order = []
  let reentrant
  scope.signal.addEventListener('abort', () => { reentrant = scope.dispose() }, { once: true })
  scope.defer(() => { order.push('first') })
  scope.defer(async () => { order.push('second:start'); await gate.promise; order.push('second:end') })
  const first = scope.dispose()
  assert.equal(scope.state, 'closing')
  assert.equal(scope.signal.aborted, true)
  assert.equal(first, reentrant)
  assert.equal(scope.dispose(), first)
  assert.deepEqual(order, ['second:start'])
  assert.throws(() => scope.register(extension()), /not open/)
  assert.throws(() => scope.defer(() => {}), /not open/)
  assert.throws(() => scope.snapshot(), /not open/)
  gate.resolve()
  await first
  assert.equal(scope.state, 'closed')
  assert.equal(scope.dispose(), first)
  assert.deepEqual(order, ['second:start', 'second:end', 'first'])
})

test('all cleanup failures are collected in reverse order and the rejection is memoized', async () => {
  const scope = createExtensionScope(), order = []
  const firstError = new Error('first'), lastError = { failure: 'last' }
  assert.throws(() => scope.defer(null), /function/)
  scope.defer(() => { order.push('first'); throw firstError })
  scope.defer(async () => { await Promise.resolve(); order.push('middle') })
  scope.defer(async () => { order.push('last'); throw lastError })
  const completion = scope.dispose()
  let reported
  await assert.rejects(completion, error => {
    reported = error
    assert(error instanceof AggregateError)
    assert.deepEqual(error.errors, [lastError, firstError])
    return true
  })
  assert.equal(scope.state, 'closed')
  assert.deepEqual(order, ['last', 'middle', 'first'])
  assert.equal(scope.dispose(), completion)
  await assert.rejects(scope.dispose(), error => error === reported)
  assert.throws(() => scope.register(extension()), /not open/)
})

test('closure in a validator prevents executor entry and retained snapshots cannot dispatch', async () => {
  const scope = createExtensionScope()
  let executions = 0
  scope.register(extension('fixture', 'fixture', {
    validateArguments() { void scope.dispose() }, execute() { executions++; return { content: '' } }
  }))
  const registry = scope.snapshot()
  await assert.rejects(registry.executeTool(call(), context()), { name: 'AbortError' })
  await scope.dispose()
  await assert.rejects(registry.executeTool(call(), context()), { name: 'AbortError' })
  assert.equal(executions, 0)
})

test('caller and owner abort restrict admitted calls without accepting late success or failure', async () => {
  for (const abortOwner of [false, true]) for (const rejectLate of [false, true]) {
    const caller = new AbortController(), scope = createExtensionScope(), gate = deferred()
    let received
    scope.register(extension('fixture', 'fixture', {
      execute(_call, { signal }) { received = signal; return gate.promise }
    }))
    const execution = scope.snapshot().executeTool(call(), { signal: caller.signal })
    const failed = assert.rejects(execution, error => error === received.reason)
    assert.equal(received.aborted, false)
    assert.notEqual(received, caller.signal)
    if (abortOwner) await scope.dispose()
    else caller.abort(new Error('Caller stopped'))
    assert.equal(received.aborted, true)
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
    assert.equal(getEventListeners(scope.signal, 'abort').length, 0)
    if (rejectLate) gate.reject(new Error('Late failure'))
    else gate.resolve({ content: 'Late success' })
    await failed
    await scope.dispose()
  }
})

test('signals release listeners on success, validation failure, tool failure and unknown dispatch', async () => {
  for (const kind of ['success', 'invalid', 'failure', 'unknown']) {
    const scope = createExtensionScope(), caller = new AbortController()
    scope.register(extension('fixture', 'fixture', {
      validateArguments() { if (kind === 'invalid') throw new Error('Invalid') },
      execute() { if (kind === 'failure') throw new Error('Failed'); return { content: 'Success' } }
    }))
    await scope.snapshot().executeTool(call(kind === 'unknown' ? 'unknown' : 'fixture'), { signal: caller.signal })
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
    assert.equal(getEventListeners(scope.signal, 'abort').length, 0)
    await scope.dispose()
  }
})

test('already aborted caller prevents entry and using the owner signal does not duplicate listeners', async () => {
  const scope = createExtensionScope(), caller = new AbortController()
  let executions = 0
  scope.register(extension('fixture', 'fixture', {
    execute(_call, { signal }) { executions++; assert.equal(getEventListeners(scope.signal, 'abort').length, 1); signal.throwIfAborted(); return { content: '' } }
  }))
  const registry = scope.snapshot()
  caller.abort(new Error('Before entry'))
  await assert.rejects(registry.executeTool(call(), { signal: caller.signal }), /Before entry/)
  assert.equal(executions, 0)
  await registry.executeTool(call(), { signal: scope.signal })
  assert.equal(executions, 1)
  assert.equal(getEventListeners(scope.signal, 'abort').length, 0)
  await scope.dispose()
})

test('scope cleanup does not wait on arbitrary tool promises; the runner retains prompt owner cancellation', async () => {
  const scope = createExtensionScope(), pending = deferred(), entered = deferred()
  let cleaned = false
  scope.register(extension('fixture', 'fixture', { execute() { entered.resolve(); return pending.promise } }))
  scope.defer(() => { cleaned = true })
  const registry = scope.snapshot()
  const running = runAgent({ provider: { async generate() { return { content: '', toolCalls: [call()] } } },
    messages: [], tools: registry.tools, executeTool: registry.executeTool, signal: scope.signal })
  await entered.promise
  await scope.dispose()
  assert.equal(cleaned, true)
  const result = await running
  assert.equal(result.status, 'cancelled')
  assert.equal(errorCode(result.history.at(-1)), 'cancelled')
  assert.equal(getEventListeners(scope.signal, 'abort').length, 0)
  pending.resolve({ content: 'Late result' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(JSON.stringify(result.history).includes('Late result'), false)
})

test('repeated create/run/dispose has no surviving signal listeners and scopes are independent', async () => {
  const neighbor = createExtensionScope()
  neighbor.register(extension('neighbor'))
  const neighborRegistry = neighbor.snapshot()
  for (let iteration = 0; iteration < 20; iteration++) {
    const scope = createExtensionScope(), caller = new AbortController()
    scope.register(extension())
    const registry = scope.snapshot()
    const result = await runAgent({ provider: { async generate({ messages }) {
      return messages.some(message => message.kind === 'tool_result')
        ? { content: 'Done', toolCalls: [] } : { content: '', toolCalls: [call()] }
    } }, messages: [], tools: registry.tools, executeTool: registry.executeTool, signal: caller.signal })
    assert.equal(result.status, 'completed')
    await scope.dispose()
    assert.equal(getEventListeners(scope.signal, 'abort').length, 0)
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
    await assert.rejects(registry.executeTool(call(), context()), { name: 'AbortError' })
    assert.equal((await neighborRegistry.executeTool(call('neighbor'), context())).content, 'neighbor')
  }
  assert.equal(neighbor.state, 'open')
  await neighbor.dispose()
})
