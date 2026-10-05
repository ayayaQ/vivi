// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { runAgent } from '../dist/index.js'
import { createToolRegistry } from '../dist/extensions.js'
import { calculate, calculatorExtension } from '../dist/extensions/calculator.js'

const call = (name = 'fixture', arguments_ = {}) => ({ id: 'call-1', name, arguments: arguments_ })
const context = () => ({ signal: new AbortController().signal })
const pack = (overrides = {}) => ({ id: 'fixture', apiVersion: 1, tools: [{
  definition: { name: 'fixture', description: 'Fixture', parameters: { type: 'object' } },
  validateArguments() {}, execute() { return { content: 'original' } }, ...overrides
}] })
const errorCode = (result) => { assert.equal(result.isError, true); return JSON.parse(result.content).error.code }

test('registration rejects invalid JavaScript contracts and all name collisions', () => {
  for (const value of [null, {}, [null], [{ ...pack(), id: '' }], [{ ...pack(), id: ' spaced ' }],
    [{ ...pack(), apiVersion: 2 }], [{ ...pack(), tools: {} }], [{ ...pack(), tools: [null] }],
    [pack({ validateArguments: null })], [pack({ execute: 7 })],
    [pack({ definition: { name: 'fixture', description: 'Fixture', parameters: [] } })],
    [pack({ definition: { name: '', description: 'Fixture', parameters: {} } })],
    [pack({ definition: { name: 'fixture', description: 'Fixture', parameters: { invalid: undefined } } })]]) {
    assert.throws(() => createToolRegistry(value))
  }
  assert.throws(() => createToolRegistry([pack(), pack()]), /Duplicate extension id/)
  assert.throws(() => createToolRegistry([pack(), { ...pack(), id: 'another' }]), /Tool name collision/)
  assert.throws(() => createToolRegistry([pack()], { reservedNames: ['fixture'] }), /Tool name collision/)
  for (const reservedNames of [null, [undefined], new Array(1), [''], [1]]) {
    assert.throws(() => createToolRegistry([], { reservedNames }))
  }
  assert.throws(() => createToolRegistry([Object.defineProperty(pack(), 'id', {
    enumerable: true, get() { throw new Error('Accessor ran') }
  })]), /plain data object/)
})

test('empty registry is valid and unknown tools cannot dispatch', async () => {
  const registry = createToolRegistry([])
  assert.deepEqual(registry.tools, [])
  assert.equal(registry.has('constructor'), false)
  assert.equal(errorCode(await registry.executeTool(call('constructor'), context())), 'unavailable_tool')
})

test('definitions, validators and executors are fixed snapshots; source objects stay untouched', async () => {
  let originalValidations = 0
  const original = pack({ validateArguments() { originalValidations++ } })
  const registry = createToolRegistry([original])
  assert.equal(Object.isFrozen(original), false)
  assert.equal(Object.isFrozen(registry), true)
  assert.equal(Object.isFrozen(registry.tools), true)
  assert.equal(Object.isFrozen(registry.tools[0].parameters), true)
  assert.throws(() => { registry.tools[0].parameters.type = 'array' }, TypeError)
  original.id = 'changed'
  original.tools[0].definition.name = 'replacement'
  original.tools[0].definition.parameters.type = 'array'
  original.tools[0].validateArguments = () => { throw new Error('replacement validation') }
  original.tools[0].execute = () => ({ content: 'replacement' })
  original.tools.length = 0
  assert.equal(registry.tools[0].name, 'fixture')
  assert.equal(registry.tools[0].parameters.type, 'object')
  assert.equal(registry.has('replacement'), false)
  assert.equal((await registry.executeTool(call(), context())).content, 'original')
  assert.equal(originalValidations, 1)
})

test('arguments are frozen once for validation and execution, result ownership is detached', async () => {
  let captured
  const output = { content: 'result' }
  const registry = createToolRegistry([pack({
    validateArguments(arguments_) {
      assert.equal(this, undefined)
      captured = arguments_
      assert.equal(Object.isFrozen(arguments_.nested), true)
      assert.throws(() => { arguments_.nested.value = 2 }, TypeError)
    },
    execute(received, receivedContext) {
      assert.equal(this, undefined)
      assert.equal(received.arguments, captured)
      assert.equal(Object.isFrozen(received), true)
      assert.equal(Object.isFrozen(receivedContext), true)
      return output
    }
  })])
  const input = call('fixture', { nested: { value: 1 } })
  const result = await registry.executeTool(input, context())
  assert.equal(Object.isFrozen(input.arguments), false)
  input.arguments.nested.value = 3
  output.content = 'changed'
  assert.equal(captured.nested.value, 1)
  assert.equal(result.content, 'result')
})

test('validation failures prevent execution, executor failures and malformed results are tool errors', async () => {
  let executed = false
  const invalid = createToolRegistry([pack({
    validateArguments() { throw new Error('Bad input') }, execute() { executed = true; return { content: '' } }
  })])
  assert.equal(errorCode(await invalid.executeTool(call(), context())), 'invalid_arguments')
  assert.equal(executed, false)
  for (const validateArguments of [() => false, async () => { throw new Error('Async validation rejected') },
    runInNewContext('(async () => { throw new Error("Cross-realm validation rejected") })'),
    () => ({ then(_resolve, reject) { reject(new Error('Thenable validation rejected')) } })]) {
    assert.equal(errorCode(await createToolRegistry([pack({ validateArguments })]).executeTool(call(), context())), 'invalid_arguments')
  }
  await new Promise((resolve) => setImmediate(resolve))
  for (const execute of [() => { throw Object.create(null) }, () => ({ content: 3 }),
    () => ({ content: '', isError: 'yes' }), () => ({ content: '', extra: undefined })]) {
    assert.equal(errorCode(await createToolRegistry([pack({ execute })]).executeTool(call(), context())), 'tool_error')
  }
})

test('malformed calls and contexts fail before extension callbacks', async () => {
  let callbacks = 0
  const registry = createToolRegistry([pack({ validateArguments() { callbacks++ }, execute() { callbacks++; return { content: '' } } })])
  for (const malformed of [null, {}, call('', {}), call('fixture', []), call('fixture', { bad: undefined }),
    call('fixture', Object.defineProperty({}, 'bad', { enumerable: true, get() { callbacks++; return 1 } }))]) {
    await assert.rejects(registry.executeTool(malformed, context()))
  }
  await assert.rejects(registry.executeTool(call(), {}), /AbortSignal/)
  assert.equal(callbacks, 0)
})

test('abort is forwarded and late success or failure cannot be accepted', async () => {
  const before = new AbortController()
  before.abort(new Error('Stopped'))
  let executions = 0
  const registry = createToolRegistry([pack({ execute() { executions++; return { content: '' } } })])
  await assert.rejects(registry.executeTool(call(), { signal: before.signal }), /Stopped/)
  assert.equal(executions, 0)
  for (const reject of [false, true]) {
    const controller = new AbortController()
    const late = createToolRegistry([pack({ async execute(_call, { signal }) {
      assert.equal(signal, controller.signal)
      controller.abort(new Error('Stopped during execution'))
      if (reject) throw new Error('Late failure')
      return { content: 'late success' }
    } })])
    await assert.rejects(late.executeTool(call(), { signal: controller.signal }), /Stopped during execution/)
  }
})

test('same calculator pack works with existing runner and keeps CLI result/error semantics', async () => {
  assert.equal(calculate('2 * (3 + 4) - .5'), 13.5)
  const registry = createToolRegistry([calculatorExtension])
  assert.deepEqual(registry.tools.map((tool) => tool.name), ['calculate'])
  for (const expression of ['process.exit()', '1/0', '2**3', '1;2', '('.repeat(30) + '1' + ')'.repeat(30), '1'.repeat(257)]) {
    assert.equal(errorCode(await registry.executeTool(call('calculate', { expression }), context())), 'invalid_arguments')
  }
  for (const args of [{}, { expression: 7 }, { expression: '1+1', unexpected: true }]) {
    assert.equal(errorCode(await registry.executeTool(call('calculate', args), context())), 'invalid_arguments')
  }
  let rounds = 0
  const result = await runAgent({
    provider: { async generate({ messages, tools }) {
      assert.equal(tools[0].name, 'calculate')
      if (++rounds === 1) return { content: '', toolCalls: [call('calculate', { expression: '4/2' })] }
      assert.equal(messages.at(-1).content, '{"result":2}')
      return { content: '2', toolCalls: [] }
    } }, messages: [], tools: registry.tools, executeTool: registry.executeTool
  })
  assert.equal(result.status, 'completed')
  assert.equal(result.content, '2')
})

test('runner promptly cancels uncooperative extension and closes pending calls without late results', async () => {
  const controller = new AbortController()
  let settle
  const pending = new Promise((resolve) => { settle = resolve })
  let started
  const ready = new Promise((resolve) => { started = resolve })
  const registry = createToolRegistry([pack({ execute() { started(); return pending } })])
  const run = runAgent({
    provider: { async generate() { return { content: '', toolCalls: [call()] } } },
    messages: [], tools: registry.tools, executeTool: registry.executeTool, signal: controller.signal
  })
  await ready
  controller.abort()
  const result = await run
  settle({ content: 'late result' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(result.status, 'cancelled')
  assert.equal(errorCode(result.history.at(-1)), 'cancelled')
  assert.equal(JSON.stringify(result.history).includes('late result'), false)
})
