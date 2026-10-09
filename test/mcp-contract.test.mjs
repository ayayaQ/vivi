// SPDX-License-Identifier: Apache-2.0
// Synthetic host contract tests for the extraction of vivi-cli
// c748317cb87a72f4e023cc21b96e793ea89e3170. No providers, transports or credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv'
import {
  createMcpExtension, MCP_LIMITS, MCP_OPERATION_LIMITS, collectMcpCategory, emptyMcpCategory, mcpAlias,
  prepareMcpOperation, assertMcpOperationCurrent, mcpOperationRevisions, mcpDigest, mcpDisplayJson,
  assertMcpJson, mcpFailure, assertMcpOperationResult, projectMcpResult,
} from '../dist/extensions/mcp.js'
import { compileMcpSchema } from '../dist/extensions/mcp/catalog.js'
import { assertMcpHostCheck, mcpRecord, mcpFreeze } from '../dist/extensions/mcp/data.js'
import { assertMcpCatalogSnapshot } from '../dist/extensions/mcp/operations.js'

const permit = () => undefined
const schema = { type: 'object', properties: { value: { type: 'integer', minimum: 1 } }, required: ['value'], additionalProperties: false }
// Real SDK compiler lives in the host/test adapter; it is absent from shared runtime imports.
function compiler(schema) {
  const validate = new AjvJsonSchemaValidator().getValidator(schema)
  return arguments_ => { if (!validate(arguments_).valid) throw new Error('Arguments rejected by host schema') }
}
async function category(kind, descriptors, options = {}) {
  return collectMcpCategory('local', kind, async () => ({ [kind]: descriptors }), new AbortController().signal, options.compiler ?? compiler, options.aliasFor)
}
async function snapshot(inputSchema = schema) {
  return structuredClone({ serverId: 'local', configRevision: 'config-v1', connectionGeneration: 'connection-v1',
    protocolVersion: '2026-07-28', catalogGeneration: 1,
    categories: { tools: await category('tools', [{ name: 'echo', description: 'untrusted text', inputSchema }]),
      resources: await category('resources', [{ uri: 'file:///exact', name: 'Exact resource' }]),
      resourceTemplates: emptyMcpCategory() } })
}
function toolCall(snapshot, arguments_ = { value: 2 }) { return { id: 'call-1', name: snapshot.categories.tools.entries[0].alias, arguments: arguments_ } }
function resourceCall(uri = 'file:///exact') { return { id: 'read-1', name: 'read_mcp_resource', arguments: { serverId: 'local', uri } } }
function prepare(snapshot, call = toolCall(snapshot)) { return prepareMcpOperation(snapshot, snapshot.categories.tools.entries[0], 'tools', call, 'launch-v1', compiler) }
function current(operation, snapshot = operation.snapshot, launch = 'launch-v1', connected = true, config = 'config-v1') {
  return assertMcpOperationCurrent(operation, snapshot, launch, connected, config)
}
function redigest(snapshot, kind) { snapshot.categories[kind].digest = mcpDigest(snapshot.categories[kind].entries); return snapshot }


test('plain JSON byte limits exactly match UTF-8 JSON encoding before serialization', () => {
  const values = [null, false, true, 0, -0, 1e-7, 1e21, 1.234, 'ascii', '\b\t\n\f\r\u0000"\\', 'é汉😀', '\ud800', '\udc00', { '\ud800': ['😀', 12] }]
  for (const value of values) {
    const bytes = Buffer.byteLength(JSON.stringify(value))
    assert.doesNotThrow(() => assertMcpJson(value, bytes))
    assert.throws(() => assertMcpJson(value, bytes - 1), /byte limit/)
  }
  assert.throws(() => assertMcpJson('x'.repeat(100000), 10), /byte limit/)
  for (const max of [-1, NaN, Infinity, 1.2]) assert.throws(() => assertMcpJson({}, max), /limits/)
})

test('plain JSON rejects getters, hidden fields, symbols, sparse arrays, extra array props, cycles and foreign prototypes', () => {
  let getterReads = 0
  const accessor = Object.defineProperty({}, 'field', { enumerable: true, get() { getterReads++; return 1 } })
  const arrayAccessor = Object.defineProperty([1], '0', { enumerable: true, get() { getterReads++; return 1 } })
  const hidden = Object.defineProperty({}, 'field', { value: 1 })
  const symbol = { [Symbol('hidden')]: 1 }
  const sparse = new Array(1), extra = Object.assign([], { field: 1 })
  const cycle = {}; cycle.self = cycle
  const proxy = new Proxy({}, { get() { throw new Error('proxy getter must not execute') } })
  for (const value of [accessor, arrayAccessor, hidden, symbol, sparse, extra, cycle, new Date(), Object.create(null), proxy,
    { missing: undefined }, { fn() {} }, NaN, Infinity, 1n, undefined]) {
    assert.throws(() => assertMcpJson(value, 65536))
  }
  assert.equal(getterReads, 0)
  assert.equal(mcpRecord(accessor), false)
  assert.equal(mcpRecord({ value: 1 }), true)
  const repeated = { a: {} }; repeated.b = repeated.a
  assert.doesNotThrow(() => assertMcpJson(repeated, 65536))
})

test('JSON complexity limits remain bounded and may be raised only explicitly for aggregates', () => {
  assert.throws(() => assertMcpJson(Array.from({ length: MCP_LIMITS.nodes }, () => 0), 65536), /complexity|bounded/)
  let deep = {}; for (let i = 0; i <= MCP_LIMITS.depth; i++) deep = { deep }
  assert.throws(() => assertMcpJson(deep, 65536), /complexity/)
  assert.doesNotThrow(() => assertMcpJson(deep, 65536, { depth: 48 }))
  const aggregate = Array.from({ length: 5000 }, () => 0)
  assert.equal(mcpDigest(aggregate).length, 64)
})

test('digest and display preserve CLI algorithms while refusing non-JSON', () => {
  const expected = createHash('sha256').update('{"a":[{"a":2,"z":1}],"z":3}').digest('hex')
  assert.equal(mcpDigest({ z: 3, a: [{ z: 1, a: 2 }] }), expected)
  assert.equal(mcpDigest({ a: [{ a: 2, z: 1 }], z: 3 }), expected)
  const displayed = mcpDisplayJson({ label: 'a\u202eb\u200dc' })
  assert.ok(displayed.includes('\\u202e') && displayed.includes('\\u200d'))
  assert.deepEqual(JSON.parse(displayed), { label: 'a\u202eb\u200dc' })
  assert.throws(() => mcpDigest({ value: undefined }))
  assert.throws(() => mcpDisplayJson(undefined))
})

test('deep freeze also freezes descendants of a shallowly frozen root', () => {
  const input = Object.freeze({ values: [{ value: 1 }] })
  assert.equal(mcpFreeze(input), input)
  assert.ok(Object.isFrozen(input.values) && Object.isFrozen(input.values[0]))
})

test('host assertion adapters reject booleans, async results and other non-undefined successes', async () => {
  assert.doesNotThrow(() => assertMcpHostCheck(permit))
  for (const value of [false, true, null, 1, {}, Promise.resolve(), Promise.reject(new Error('invalid async adapter'))]) {
    assert.throws(() => assertMcpHostCheck(() => value), /undefined synchronously/)
  }
  assert.throws(() => assertMcpHostCheck(() => { throw new Error('host rejection') }), /host rejection/)
  await Promise.resolve()
})

test('aliases bind local authority and catalog kind using the pinned CLI hash', () => {
  const suffix = createHash('sha256').update(JSON.stringify(['tools', 'echo'])).digest('hex').slice(0, 32)
  assert.equal(mcpAlias('local', 'tools', 'echo'), `mcp_local_${suffix}`)
  assert.notEqual(mcpAlias('local', 'tools', 'echo'), mcpAlias('other', 'tools', 'echo'))
  assert.notEqual(mcpAlias('local', 'tools', 'echo'), mcpAlias('local', 'resources', 'echo'))
  for (const id of ['', 'Remote', 'remote.site', '../remote', 'a'.repeat(17)]) assert.throws(() => mcpAlias(id, 'tools', 'echo'), /local/)
  assert.throws(() => mcpAlias('local', 'templates', 'echo'), /identity/)
})

test('discovery is explicit one-page-at-a-time, sorted, bounded, copied and deeply frozen', async () => {
  const page1 = { tools: [{ name: 'z', inputSchema: schema }], nextCursor: 'page2' }
  const page2 = { tools: [{ name: 'a', inputSchema: schema }] }, calls = []
  const result = await collectMcpCategory('local', 'tools', async (cursor, signal) => {
    assert.equal(signal.aborted, false); calls.push(cursor); return cursor === undefined ? page1 : page2
  }, new AbortController().signal, compiler)
  assert.deepEqual(calls, [undefined, 'page2'])
  assert.deepEqual(result.entries.map(entry => entry.remoteKey), ['a', 'z'])
  assert.equal(result.state, 'ready'); assert.equal(result.digest, mcpDigest(result.entries))
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.entries) && Object.isFrozen(result.entries[0].descriptor.inputSchema))
  page1.tools[0].name = 'changed'; page2.tools[0].inputSchema = {}
  assert.equal(result.entries[0].descriptor.inputSchema.type, 'object')
  assert.equal(result.entries[1].remoteKey, 'z')
})

test('conservative schema subset quarantines unsupported capabilities and malformed constraints', async () => {
  const rejected = [
    { type: 'object', patternProperties: {} }, { type: 'object', $ref: '#/x' }, { type: 'object', $id: 'https://example.test/schema' },
    { type: 'object', $defs: {} }, { type: 'object', allOf: [{}] }, { type: 'object', prefixItems: [{}] },
    { type: 'object', properties: { x: { items: [{ type: 'string' }] } } }, { type: 'object', required: ['x', 'x'] },
    { type: 'object', enum: [{ x: 1 }, { x: 1 }] }, { type: 'object', minimum: '1' }, { type: 'object', multipleOf: 0 },
    { type: 'object', minProperties: -1 }, { type: 'object', uniqueItems: 'yes' }, { type: 'object', typex: 'object' },
    { type: 'object', $schema: 'https://unknown.test/schema' }, { type: 'object', $schema: { toString: 'not callable' } }, { type: 'object', properties: [] }, true,
  ]
  const descriptors = rejected.map((inputSchema, i) => ({ name: `rejected-${i}`, inputSchema }))
  descriptors.push({ name: 'task', inputSchema: schema, execution: { taskSupport: 'required' } },
    { name: 'header', inputSchema: schema, 'x-mcp-header': {} }, { name: 'output', inputSchema: schema, outputSchema: { type: 'object', pattern: 'x' } },
    { name: 'array-root', inputSchema: { type: 'array' } })
  const result = await category('tools', descriptors)
  assert.ok(result.entries.every(entry => entry.state === 'quarantined' && entry.reason))
  const safe = await category('tools', [{ name: 'safe', inputSchema: { type: 'object', properties: { any: true, no: false }, additionalProperties: false } }])
  assert.equal(safe.entries[0].state, 'available')
})

test('compiler failures quarantine tools without exposing server errors as trusted metadata', async () => {
  for (const badCompiler of [() => { throw new Error('remote detailed failure') }, () => false, async () => permit]) {
    const result = await category('tools', [{ name: 'echo', inputSchema: schema }], { compiler: badCompiler })
    assert.equal(result.entries[0].state, 'quarantined')
    assert.equal(result.entries[0].reason, 'Invalid schema')
  }
})

test('catalog limits reject duplicates, collisions, pages, entries and repeated or oversized cursors', async () => {
  const signal = new AbortController().signal
  await assert.rejects(category('resources', [{ uri: 'same' }, { uri: 'same' }]), /duplicate/)
  await assert.rejects(category('tools', [{ name: 'a', inputSchema: schema }, { name: 'b', inputSchema: schema }], { aliasFor: () => 'collision' }), /collision/)
  await assert.rejects(category('tools', [{ name: 'a', inputSchema: schema }], { aliasFor: () => 'bad.alias' }), /collision/)
  await assert.rejects(category('resources', Array.from({ length: 257 }, (_, i) => ({ uri: `resource:${i}` }))), /limit/)
  await assert.rejects(collectMcpCategory('local', 'resources', async () => ({ resources: [], nextCursor: 'same' }), signal, compiler), /repeated/)
  await assert.rejects(collectMcpCategory('local', 'resources', async () => ({ resources: [], nextCursor: 'é'.repeat(2049) }), signal, compiler), /cursor/)
  let pages = 0
  await assert.rejects(collectMcpCategory('local', 'resources', async () => ({ resources: [], nextCursor: `page-${++pages}` }), signal, compiler), /pagination/)
  assert.equal(pages, MCP_LIMITS.pages)
  await assert.rejects(collectMcpCategory('invalid.id', 'resources', async () => ({ resources: [] }), signal, compiler), /local/)
})

test('all catalog metadata is bounded before schema compilation or JSON encoding', async () => {
  let compilations = 0, getterReads = 0
  const compile = () => { compilations++; return permit }
  const oversized = { tools: [{ name: 'echo', inputSchema: schema }], extra: 'x'.repeat(MCP_LIMITS.bytes) }
  await assert.rejects(collectMcpCategory('local', 'tools', async () => oversized, new AbortController().signal, compile), /byte limit/)
  const accessor = Object.defineProperty({ tools: [] }, 'metadata', { enumerable: true, get() { getterReads++; return 'x' } })
  await assert.rejects(collectMcpCategory('local', 'tools', async () => accessor, new AbortController().signal, compile), /accessors/)
  await assert.rejects(category('tools', [{ name: 'echo', inputSchema: schema, description: 'x'.repeat(MCP_LIMITS.descriptorBytes) }], { compiler: compile }), /byte limit/)
  assert.equal(compilations, 0); assert.equal(getterReads, 0)
})

test('stored catalog entries stay within the byte budget after repeating remote identities', async () => {
  const descriptors = Array.from({ length: 140 }, (_, index) => ({ uri: `resource:${index}:${'x'.repeat(4000)}` }))
  assert.ok(Buffer.byteLength(JSON.stringify({ resources: descriptors })) < MCP_LIMITS.bytes)
  await assert.rejects(category('resources', descriptors), /byte limit/)
})

test('a never-resolving page has a real local deadline without host cooperation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let pageSignal
  const pending = collectMcpCategory('local', 'resources', async (_cursor, signal) => { pageSignal = signal; return new Promise(() => {}) }, new AbortController().signal, compiler)
  await Promise.resolve()
  t.mock.timers.tick(MCP_LIMITS.pageMs)
  await assert.rejects(pending, /deadline/)
  assert.equal(pageSignal.aborted, true)
})

test('discovery honors caller cancellation even if readPage never resolves', async () => {
  const controller = new AbortController()
  const pending = collectMcpCategory('local', 'resources', async () => new Promise(() => {}), controller.signal, compiler)
  controller.abort(new Error('caller cancelled'))
  await assert.rejects(pending, /caller cancelled/)
})

test('category-wide deadline is checked even on empty pages and before final return', async t => {
  let time = 0, pages = 0
  t.mock.method(performance, 'now', () => time)
  const pending = collectMcpCategory('local', 'resources', async () => { time += 6000; return { resources: [], nextCursor: `page-${++pages}` } }, new AbortController().signal, compiler)
  await assert.rejects(pending, /deadline/)
  assert.equal(pages, 2)
})

test('official host compiler enforces concrete arguments for modern and legacy schema dialects', async () => {
  const dialects = ['https://json-schema.org/draft/2020-12/schema', 'https://json-schema.org/draft/2019-09/schema',
    'http://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft-06/schema#']
  for (const $schema of dialects) {
    const input = { $schema, type: 'object', properties: {
      n: { type: 'integer', minimum: 2, maximum: 10, exclusiveMinimum: 1, exclusiveMaximum: 11, multipleOf: 2 },
      text: { type: 'string', minLength: 2, maxLength: 4 },
      list: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1, maxItems: 2, uniqueItems: true },
      flag: { const: true }, nested: { type: 'object', properties: { x: { type: ['string', 'null'] } }, required: ['x'], additionalProperties: false },
    }, required: ['n', 'text', 'list', 'flag', 'nested'], additionalProperties: false }
    const captured = await snapshot(input), good = { n: 4, text: 'ok', list: ['a'], flag: true, nested: { x: null } }
    assert.equal(captured.categories.tools.entries[0].state, 'available', $schema)
    assert.doesNotThrow(() => prepare(captured, toolCall(captured, good)))
    for (const bad of [{ ...good, n: 3 }, { ...good, n: 12 }, { ...good, text: 'x' }, { ...good, text: 'longer' },
      { ...good, list: [] }, { ...good, list: ['a', 'a'] }, { ...good, list: ['c'] }, { ...good, flag: false },
      { ...good, nested: {} }, { ...good, extra: true }]) {
      assert.throws(() => prepare(captured, toolCall(captured, bad)), /Arguments rejected/, $schema)
    }
  }
})

test('prepared operation has exact CLI binding fields and cloned frozen approval data', async () => {
  const captured = await snapshot(), call = toolCall(captured), operation = prepare(captured, call)
  assert.deepEqual(Object.keys(operation).sort(), ['binding', 'call', 'catalogKind', 'descriptor', 'remoteKey', 'serverId', 'snapshot'])
  assert.deepEqual(Object.keys(operation.binding).sort(), ['catalogGeneration', 'categoryDigest', 'configRevision', 'connectionGeneration', 'descriptorDigest', 'launchDigest', 'operationDigest', 'protocolVersion', 'serverId'])
  assert.equal(operation.binding.operationDigest, mcpDigest({ call: operation.call, serverId: operation.serverId, catalogKind: operation.catalogKind,
    remoteKey: operation.remoteKey, descriptor: operation.descriptor, snapshot: operation.snapshot }))
  assert.equal(operation.binding.descriptorDigest, mcpDigest(operation.descriptor))
  assert.ok(Object.isFrozen(operation) && Object.isFrozen(operation.call.arguments) && Object.isFrozen(operation.snapshot.categories.tools.entries))
  assert.notEqual(operation.snapshot, captured); assert.notEqual(operation.call, call)
  call.arguments.value = 100; captured.categories.tools.entries[0].descriptor.description = 'changed'
  assert.equal(operation.call.arguments.value, 2); assert.equal(operation.descriptor.description, 'untrusted text')
  assert.doesNotThrow(() => current(operation))
})

test('preparation rejects non-members, stale/quarantined entries, alias substitution and invalid JSON arguments', async () => {
  const captured = await snapshot(), entry = captured.categories.tools.entries[0], call = toolCall(captured)
  assert.throws(() => prepareMcpOperation(captured, structuredClone(entry), 'tools', call, 'launch-v1', compiler), /unavailable/)
  assert.throws(() => prepare(captured, { ...call, name: 'echo' }), /alias/)
  assert.throws(() => prepare(captured, { ...call, arguments: { value: 2, unexpected: true } }), /Arguments rejected/)
  assert.throws(() => prepare(captured, { ...call, arguments: { value: undefined } }), /JSON/)
  const stale = structuredClone(captured); stale.categories.tools.state = 'stale'
  assert.throws(() => prepare(stale), /unavailable/)
  const quarantine = structuredClone(captured); quarantine.categories.tools.entries[0].state = 'quarantined'; redigest(quarantine, 'tools')
  assert.throws(() => prepare(quarantine), /unavailable/)
})

test('prepare rejects false and async validators despite JavaScript void assignability', async () => {
  const captured = await snapshot(), entry = captured.categories.tools.entries[0], call = toolCall(captured)
  for (const badCompiler of [() => () => false, () => async () => undefined, () => true, async () => permit]) {
    assert.throws(() => prepareMcpOperation(captured, entry, 'tools', call, 'launch-v1', badCompiler), /assertion|synchronously/)
  }
  const original = structuredClone(schema)
  const validate = compileMcpSchema(original, capturedSchema => {
    assert.ok(Object.isFrozen(capturedSchema.properties.value))
    return permit
  })
  original.type = 'array'
  assert.doesNotThrow(() => validate({ value: 2 }))
})

test('direct schema compilation and available-entry preparation cannot bypass the safe subset', async () => {
  const unsupported = [
    { type: 'object', $ref: '#/properties/value' },
    { type: 'object', properties: { value: { type: 'string', pattern: '^safe$' } } },
    { type: 'object', anyOf: [{ required: ['value'] }] },
  ]
  for (const inputSchema of unsupported) {
    let compilations = 0
    const hostCompiler = () => { compilations++; return permit }
    assert.throws(() => compileMcpSchema(inputSchema, hostCompiler), /Unsupported|Referenced/)
    const captured = await snapshot()
    captured.categories.tools.entries[0].descriptor.inputSchema = inputSchema
    redigest(captured, 'tools')
    assert.throws(() => prepareMcpOperation(captured, captured.categories.tools.entries[0], 'tools', toolCall(captured), 'launch-v1', hostCompiler), /Unsupported|Referenced/)
    assert.throws(() => createMcpExtension({ captureCatalogs: async () => [captured], prepareOperation: permit }, [captured], async () => ({ content: '' }),
      { validateSchema: hostCompiler, assertAllowed: permit }), /Unsupported|Referenced/)
    assert.equal(compilations, 0)
  }
})

test('direct proposals retain required-task, header and output-schema quarantine restrictions', async () => {
  for (const descriptorFields of [
    { execution: { taskSupport: 'required' } }, { 'x-mcp-header': {} },
    { outputSchema: { type: 'object', allOf: [{}] } }, { outputSchema: { type: 'string', pattern: '^safe$' } },
  ]) {
    const captured = await snapshot()
    Object.assign(captured.categories.tools.entries[0].descriptor, descriptorFields)
    redigest(captured, 'tools')
    let compilations = 0
    const hostCompiler = () => { compilations++; return permit }
    assert.throws(() => prepareMcpOperation(captured, captured.categories.tools.entries[0], 'tools', toolCall(captured), 'launch-v1', hostCompiler), /Required task|Header declarations|Unsupported|Referenced/)
    assert.equal(compilations, 0)
  }
  const captured = await snapshot()
  captured.categories.tools.entries[0].descriptor.outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }
  redigest(captured, 'tools')
  const compiled = [], assertions = []
  const hostCompiler = schema => { compiled.push(schema); return arguments_ => { assertions.push(arguments_) } }
  assert.doesNotThrow(() => prepareMcpOperation(captured, captured.categories.tools.entries[0], 'tools', toolCall(captured), 'launch-v1', hostCompiler))
  assert.equal(compiled.length, 2); assert.equal(assertions.length, 1)
  assert.equal(compiled[0].required[0], 'answer')
  assert.deepEqual(assertions[0], { value: 2 })
})

test('binding comparison fails closed for every changed identity and missing/extra binding fields', async () => {
  const captured = await snapshot(), operation = prepare(captured)
  for (const [key, value] of [['serverId', 'other'], ['configRevision', 'config-v2'], ['connectionGeneration', 'connection-v2'],
    ['protocolVersion', 'legacy'], ['catalogGeneration', 2]]) {
    const changed = structuredClone(captured); changed[key] = value
    assert.throws(() => current(operation, changed), /stale|Invalid/)
  }
  assert.throws(() => current(operation, captured, 'launch-v2'), /stale/)
  assert.throws(() => current(operation, captured, 'launch-v1', true, 'config-v2'), /stale/)
  assert.throws(() => current(operation, captured, 'launch-v1', false), /stale/)
  assert.throws(() => current(operation, undefined, 'launch-v1', false), /stale/)
  const changed = structuredClone(captured); changed.categories.tools.entries[0].descriptor.description = 'new'; redigest(changed, 'tools')
  assert.throws(() => current(operation, changed), /stale/)
  const stale = structuredClone(captured); stale.categories.tools.state = 'stale'
  assert.throws(() => current(operation, stale), /stale/)
  const missing = structuredClone(operation); delete missing.binding.launchDigest
  assert.throws(() => current(missing, captured), /binding/)
  const extra = structuredClone(operation); extra.binding.unexpected = true
  assert.throws(() => current(extra, captured), /binding/)
  const altered = structuredClone(operation); altered.call.arguments.value = 4
  assert.throws(() => current(altered, captured), /stale/)
})

test('revision view reproduces CLI host-review evidence without granting approval', async () => {
  const captured = await snapshot(), operation = prepare(captured)
  const evidence = mcpOperationRevisions(operation, captured, 'launch-v1', true, 'config-v1')
  for (const [key, value] of Object.entries(operation.binding)) assert.equal(evidence[key], value)
  assert.equal(evidence.bindingDigest, mcpDigest(operation.binding)); assert.equal(evidence.connected, true); assert.equal(evidence.categoryReady, true)
  const disconnected = mcpOperationRevisions(operation, undefined, '', false, 'config-v1')
  assert.equal(disconnected.connectionGeneration, ''); assert.equal(disconnected.catalogGeneration, -1)
  assert.equal(disconnected.connected, false); assert.equal(disconnected.categoryReady, false)
})

test('snapshot assertion rejects inconsistent category digests, identities and missing categories', async () => {
  const captured = await snapshot()
  assert.doesNotThrow(() => assertMcpCatalogSnapshot(captured))
  const badDigest = structuredClone(captured); badDigest.categories.tools.digest = 'invented'
  assert.throws(() => assertMcpCatalogSnapshot(badDigest), /category/)
  const badKey = structuredClone(captured); badKey.categories.resources.entries[0].remoteKey = 'different'; redigest(badKey, 'resources')
  assert.throws(() => assertMcpCatalogSnapshot(badKey), /identity/)
  const missing = structuredClone(captured); delete missing.categories.resourceTemplates
  assert.throws(() => assertMcpCatalogSnapshot(missing), /snapshot/)
})

test('resource preparation accepts only the fixed read tool and exact discovered serverId/URI', async () => {
  const captured = await snapshot(), entry = captured.categories.resources.entries[0]
  const operation = prepareMcpOperation(captured, entry, 'resources', resourceCall(), 'launch-v1', compiler)
  assert.equal(operation.remoteKey, 'file:///exact'); assert.doesNotThrow(() => current(operation))
  for (const call of [{ ...resourceCall(), name: entry.alias }, resourceCall('file:///exact/child'),
    { ...resourceCall(), arguments: { serverId: 'other', uri: 'file:///exact' } },
    { ...resourceCall(), arguments: { serverId: 'local', uri: 'file:///exact', linked: true } },
    { ...resourceCall(), arguments: { uri: 'file:///exact' } }]) {
    assert.throws(() => prepareMcpOperation(captured, entry, 'resources', call, 'launch-v1', compiler), /selection/)
  }
})

test('foreign result families, malformed envelopes and unbounded content are rejected', () => {
  for (const result of [{ task: {}, content: [] }, { inputRequests: [], content: [] }, { requestState: 'pending', content: [] },
    { toolResult: {}, content: [] }, { resultType: 'incomplete', content: [] }, { content: [], isError: 'false' },
    { contents: [] }, { content: Array.from({ length: MCP_OPERATION_LIMITS.contentItems + 1 }, () => ({ type: 'text', text: '' })) },
    { content: [{ type: 'text', text: 'x'.repeat(MCP_OPERATION_LIMITS.resultBytes) }] }]) {
    assert.throws(() => assertMcpOperationResult('tools/call', result))
  }
  assert.throws(() => assertMcpOperationResult('invalid', { content: [] }), /method/)
  assert.doesNotThrow(() => assertMcpOperationResult('tools/call', { resultType: 'complete', content: [] }))
})

test('result projection preserves bounded untrusted data, omits binary/raw envelope and never follows links', () => {
  const raw = { content: [{ type: 'text', text: 'untrusted instructions', annotations: { audience: ['assistant'] } },
    { type: 'image', data: 'binary', mimeType: 'image/png' }, { type: 'audio', data: 'binary', mimeType: 'audio/mp3' },
    { type: 'resource_link', uri: 'https://example.test/no-fetch', name: 'link', description: 'untrusted' },
    { type: 'resource', resource: { uri: 'resource:embedded', blob: 'binary' } }],
    structuredContent: { value: 1 }, instructions: 'must be dropped', _meta: { must: 'be dropped' } }
  let checks = 0
  const result = projectMcpResult('local', 'tools/call', 'echo', raw, admitted => {
    checks++; assert.ok(Object.isFrozen(admitted.content[0])); assert.equal(admitted.instructions, 'must be dropped')
  })
  const projected = JSON.parse(result.content)
  assert.equal(checks, 1); assert.equal(projected.source, 'mcp'); assert.equal(projected.untrusted, true); assert.equal(projected.success, true)
  assert.equal(projected.instructions, undefined); assert.equal(projected._meta, undefined)
  assert.deepEqual(projected.content[0], { type: 'text', text: 'untrusted instructions' })
  assert.deepEqual(projected.content[1], { type: 'image', binaryOmitted: true, mimeType: 'image/png' })
  assert.deepEqual(projected.content[2], { type: 'audio', binaryOmitted: true, mimeType: 'audio/mp3' })
  assert.equal(projected.content[3].uri, 'https://example.test/no-fetch')
  assert.equal(projected.content[4].resource.binaryOmitted, true)
  assert.deepEqual(projected.structuredContent, { value: 1 }); assert.equal(result.isError, undefined)
})

test('privacy policy is required and must succeed synchronously before projection', () => {
  const raw = { content: [{ type: 'text', text: 'blocked ordinary test data' }] }
  assert.throws(() => projectMcpResult('local', 'tools/call', 'echo', raw), /host/)
  assert.throws(() => projectMcpResult('local', 'tools/call', 'echo', raw, () => { throw new Error('policy withheld') }), /policy withheld/)
  for (const check of [() => false, async () => undefined]) assert.throws(() => projectMcpResult('local', 'tools/call', 'echo', raw, check), /synchronously/)
  assert.throws(() => projectMcpResult('local', 'tools/call', 'echo', { content: [{ type: 'unknown' }] }, permit), /Unsupported/)
})

test('resource projection enforces the exact approved URI and omits every blob', () => {
  const body = JSON.parse(projectMcpResult('local', 'resources/read', 'file:///exact', { contents: [{ uri: 'file:///exact', blob: 'binary', mimeType: 'application/octet-stream' }] }, permit).content)
  assert.deepEqual(body.content, [{ uri: 'file:///exact', mimeType: 'application/octet-stream', binaryOmitted: true }])
  assert.throws(() => projectMcpResult('local', 'resources/read', 'file:///exact', { contents: [{ uri: 'file:///exact/child', text: 'untrusted' }] }, permit), /approved URI/)
  const failed = projectMcpResult('local', 'tools/call', 'echo', { content: [], isError: true }, permit)
  assert.equal(failed.isError, true); assert.equal(JSON.parse(failed.content).success, false)
})

test('unknown outcomes explicitly disable automatic retries', () => {
  const failure = mcpFailure('unconfirmed', 'Outcome is unknown', true), body = JSON.parse(failure.content)
  assert.equal(failure.isError, true); assert.equal(body.unknownOutcome, true); assert.equal(body.doNotRetry, true)
  assert.equal(body.untrusted, true); assert.deepEqual(body.error, { code: 'unconfirmed', message: 'Outcome is unknown' })
})

test('failure projections enforce types and the same bounded JSON result budget', () => {
  for (const arguments_ of [[1, 'message'], ['code', {}], ['code', 'message', 'true']]) assert.throws(() => mcpFailure(...arguments_), /Invalid/)
  assert.throws(() => mcpFailure('code', 'x'.repeat(MCP_OPERATION_LIMITS.resultBytes)), /byte limit/)
})

test('fixed extension proposes captured operations through explicit host review only', async () => {
  const captured = await snapshot(), reviewed = [], prepared = []
  const host = { captureCatalogs: async () => [captured], prepareOperation(snapshot, entry, kind, call) {
    prepared.push(kind); return prepareMcpOperation(snapshot, entry, kind, call, 'launch-v1', compiler)
  } }
  const extension = createMcpExtension(host, [captured], async operation => { reviewed.push(operation); return { content: 'host-reviewed result' } }, { validateSchema: compiler, assertAllowed: permit })
  const tool = extension.tools.find(tool => tool.definition.name === captured.categories.tools.entries[0].alias)
  tool.validateArguments({ value: 2 })
  const result = await tool.execute(toolCall(captured), { signal: new AbortController().signal })
  assert.equal(result.content, 'host-reviewed result'); assert.deepEqual(prepared, ['tools']); assert.equal(reviewed.length, 1)
  const list = extension.tools.find(tool => tool.definition.name === 'list_mcp_resources')
  const metadata = JSON.parse((await list.execute({ id: 'list-1', name: 'list_mcp_resources', arguments: {} }, { signal: new AbortController().signal })).content)
  assert.equal(metadata.localMetadataOnly, true); assert.equal(reviewed.length, 1); assert.deepEqual(prepared, ['tools'])
})

test('both ESM and CJS expose the shared pure MCP helpers', () => {
  const require = createRequire(import.meta.url), cjs = require('../dist/cjs/extensions/mcp.js')
  for (const name of ['createMcpExtension', 'collectMcpCategory', 'prepareMcpOperation', 'assertMcpOperationCurrent', 'mcpOperationRevisions', 'projectMcpResult']) {
    assert.equal(typeof cjs[name], 'function')
  }
  assert.equal(cjs.mcpAlias('local', 'tools', 'echo'), mcpAlias('local', 'tools', 'echo'))
})
