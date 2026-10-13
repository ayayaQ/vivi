// SPDX-License-Identifier: Apache-2.0
// Fixture-only scalar RFC 6570 host adapters. No live MCP, credentials or transport SDK.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createToolRegistry } from '../dist/extensions.js'
import { collectMcpCategory, emptyMcpCategory, createMcpExtension, prepareMcpOperation,
  assertMcpOperationCurrent, mcpOperationRevisions, mcpOperationRequest, mcpDigest, mcpFailure,
  projectMcpResult, mcpTemplateVariables, expandMcpResourceTemplate } from '../dist/extensions/mcp.js'

const permit = () => undefined, compiler = () => permit
const signal = () => new AbortController().signal
// Synthetic no-I/O expansion for the admitted scalar operator subset, not a production host adoption.
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)
function expand(template, variables) {
  return template.replace(/\{([+#./;?&]?)([^}]+)\}/g, (_expression, operator, names) => {
    const fields = names.split(',').map(name => {
      const value = variables[name]
      const encoded = operator === '+' || operator === '#' ? encodeURI(value).replace(/%25([0-9A-Fa-f]{2})/g, '%$1') : encode(value)
      return [';', '?', '&'].includes(operator) ? name + (operator === ';' && value === '' ? '' : `=${encoded}`) : encoded
    })
    const prefix = { '+': '', '#': '#', '.': '.', '/': '/', ';': ';', '?': '?', '&': '&' }[operator] ?? ''
    const separator = { '.': '.', '/': '/', ';': ';', '?': '&', '&': '&' }[operator] ?? ','
    return prefix + fields.join(separator)
  })
}
async function snapshot(template = 'docs://items/{id}{?q}') {
  const resourceTemplates = await collectMcpCategory('docs', 'resourceTemplates', async () => ({ resourceTemplates: [{ uriTemplate: template, name: 'Items' }] }), signal(), compiler)
  const resources = await collectMcpCategory('docs', 'resources', async () => ({ resources: [{ uri: 'docs://exact' }] }), signal(), compiler)
  return structuredClone({ serverId: 'docs', configRevision: 'config-1', connectionGeneration: 'connection-1', protocolVersion: '2026-07-28', catalogGeneration: 1,
    categories: { tools: emptyMcpCategory(), resources, resourceTemplates } })
}
const call = (variables = { id: 'a/b 😀', q: 'x&y' }, uriTemplate = 'docs://items/{id}{?q}') => ({ id: 'read-1', name: 'read_mcp_resource_template', arguments: { serverId: 'docs', uriTemplate, variables } })
const prepare = (s, c = call(), expander = expand) => prepareMcpOperation(s, s.categories.resourceTemplates.entries[0], 'resourceTemplates', c, 'launch-1', compiler, expander)
const current = (operation, s = operation.snapshot, expander = expand) => assertMcpOperationCurrent(operation, s, 'launch-1', true, 'config-1', expander)
const redigest = s => { s.categories.resourceTemplates.digest = mcpDigest(s.categories.resourceTemplates.entries); return s }

test('scalar admission identifies exact variables for every supported RFC 6570 operator', () => {
  for (const operator of ['', '+', '#', '.', '/', ';', '?', '&']) {
    assert.deepEqual(mcpTemplateVariables(`docs://base{${operator}id,query.name}{id}`), ['id', 'query.name'])
  }
  const expected = ['', '+', '#', '.', '/', ';', '?', '&'].map(operator => expandMcpResourceTemplate(`docs://base{${operator}id}`, { id: 'a/b' }, expand))
  assert.deepEqual(expected, ['docs://basea%2Fb', 'docs://basea/b', 'docs://base#a/b', 'docs://base.a%2Fb', 'docs://base/a%2Fb', 'docs://base;id=a%2Fb', 'docs://base?id=a%2Fb', 'docs://base&id=a%2Fb'])
  assert.equal(expandMcpResourceTemplate('docs://{id}', { id: 'é汉😀 !%?#/' }, expand), 'docs://%C3%A9%E6%B1%89%F0%9F%98%80%20%21%25%3F%23%2F')
  assert.equal(expandMcpResourceTemplate('docs://items{?q}', { q: '' }, expand), 'docs://items?q=')
})

test('malformed and unsupported templates are quarantined and cannot bypass direct preparation', async () => {
  const bad = ['docs://{id', 'docs://id}', 'docs://{{id}}', 'docs://{}', 'docs://{id,}', 'docs://{!id}',
    'docs://{id:2}', 'docs://{id*}', 'docs://{%69d}', 'docs://plain', '/relative/{id}', 'docs://space here/{id}',
    'docs://%zz/{id}', 'docs://汉/{id}', `docs://{${Array.from({ length: 33 }, (_, i) => `v${i}`).join(',')}}`]
  for (const template of bad) {
    assert.throws(() => mcpTemplateVariables(template), undefined, template)
    const s = await snapshot(template)
    assert.equal(s.categories.resourceTemplates.entries[0].state, 'quarantined', template)
    assert.throws(() => prepare(s, call({ id: 'x' }, template)), /unavailable/, template)
    s.categories.resourceTemplates.entries[0].state = 'available'; redigest(s)
    assert.throws(() => prepare(s, call({ id: 'x' }, template)), undefined, template)
  }
})

test('missing, extra, composite, non-string, hidden and oversized values fail before host expansion', async () => {
  const s = await snapshot()
  let expansions = 0
  const counted = (...args) => { expansions++; return expand(...args) }
  const getter = Object.defineProperty({ id: 'x' }, 'q', { enumerable: true, get() { throw new Error('must not read') } })
  for (const variables of [{ id: 'x' }, { id: 'x', q: 'y', extra: '' }, { id: 1, q: 'y' }, { id: ['x'], q: 'y' },
    { id: { nested: 'x' }, q: 'y' }, { id: 'x\n', q: 'y' }, { id: '汉'.repeat(1400), q: 'y' }, getter, Object.create(null)]) {
    assert.throws(() => prepare(s, call(variables), counted))
  }
  assert.equal(expansions, 0)
})

test('host expansion must be synchronous and return one bounded absolute URI without normalization', async () => {
  const s = await snapshot()
  for (const value of [undefined, false, {}, 'relative', 'docs://{id}', 'docs://bad space', 'docs://bad%xx', 'docs://' + 'x'.repeat(4096), 'docs://汉', Promise.resolve('docs://x'), Promise.reject(new Error('invalid async adapter'))]) {
    assert.throws(() => prepare(s, call(), () => value))
  }
  for (const uri of ['docs://[::1/x', 'docs://[not-an-ip]/x', 'docs:/path/x#first#second', 'docs:/raw[brackets]',
    'docs://one@two@three/x', 'docs://host:abc/x', 'docs://[::1]:abc/x', 'docs://[vX.addr]/x', 'docs://[fe80::1%25eth0]/x']) assert.throws(() => prepare(s, call(), () => uri), /Invalid MCP resource URI/)
  for (const uri of ['docs:opaque', 'docs:', 'urn:example:a%20b', 'docs:///absolute', 'docs://[::1]/x',
    'docs://[vF.custom:addr]/x', 'docs://user:pass@name:12/x?first?second#part/ok?yes', 'docs://reg!$&\'()*+,;=name:/x']) {
    assert.equal(prepare(s, call(), () => uri).resourceUri, uri)
  }
  let captured
  const original = { id: 'x', q: '' }
  const operation = prepare(s, call(original), (template, variables) => { captured = variables; assert(Object.isFrozen(variables)); return expand(template, variables) })
  original.id = 'changed'
  assert.equal(captured.id, 'x'); assert.equal(operation.resourceUri, 'docs://items/x?q=')
  assert.throws(() => prepareMcpOperation(s, s.categories.resourceTemplates.entries[0], 'resourceTemplates', call(), 'launch-1', compiler), /expander/)
  await Promise.resolve()
})

test('template binding freezes descriptor, exact values and URI separately from catalog identity', async () => {
  const s = await snapshot(), c = call(), operation = prepare(s, c)
  assert.equal(operation.remoteKey, 'docs://items/{id}{?q}')
  assert.equal(operation.catalogKind, 'resourceTemplates')
  assert.equal(operation.resourceUri, 'docs://items/a%2Fb%20%F0%9F%98%80?q=x%26y')
  assert.deepEqual(mcpOperationRequest(operation), { method: 'resources/read', params: { uri: operation.resourceUri } })
  assert(Object.isFrozen(operation.call.arguments.variables)); assert(Object.isFrozen(operation.snapshot)); assert(Object.isFrozen(operation.binding))
  c.arguments.variables.id = 'changed'; s.categories.resourceTemplates.entries[0].descriptor.name = 'changed'
  assert.equal(operation.descriptor.name, 'Items'); assert.equal(operation.call.arguments.variables.id, 'a/b 😀')
  assert.doesNotThrow(() => current(operation))
  const revisions = mcpOperationRevisions(operation, operation.snapshot, 'launch-1', true, 'config-1', expand)
  assert.equal(revisions.categoryDigest, operation.snapshot.categories.resourceTemplates.digest)
})

test('template approvals invalidate on refresh, descriptor changes, capability loss and expander changes', async () => {
  const operation = prepare(await snapshot())
  const changes = [s => s.catalogGeneration++, s => s.connectionGeneration = 'connection-2', s => s.configRevision = 'config-2',
    s => s.categories.resourceTemplates.state = 'stale', s => { s.categories.resourceTemplates.entries[0].descriptor.name = 'new'; redigest(s) },
    s => s.categories.resourceTemplates = emptyMcpCategory()]
  for (const change of changes) { const s = structuredClone(operation.snapshot); change(s); assert.throws(() => current(operation, s)) }
  assert.throws(() => current(operation, operation.snapshot, () => 'docs://other'), /expansion changed/)
  assert.throws(() => assertMcpOperationCurrent(operation, operation.snapshot, 'launch-1', true, 'config-1'), /expander/)
  for (const change of [s => s.resourceUri = 'docs://other', s => s.call.arguments.variables.id = 'other', s => s.extra = true]) {
    const forged = structuredClone(operation); change(forged); assert.throws(() => current(forged)); assert.throws(() => mcpOperationRequest(forged))
  }
})

class CliHost {
  sent = []; approved = new WeakSet(); attempted = new WeakSet(); connected = true; beforeSend = () => {}; outcome = 'complete'
  constructor(snapshot) { this.snapshot = snapshot }
  async captureCatalogs(abortSignal) { abortSignal.throwIfAborted(); return [this.snapshot] }
  prepareOperation(s, entry, kind, c) { const operation = prepareMcpOperation(s, entry, kind, c, 'launch-1', compiler, expand); this.assertCurrent(operation); return operation }
  assertCurrent(operation) { assertMcpOperationCurrent(operation, this.snapshot, 'launch-1', this.connected, 'config-1', expand) }
  async invoke(operation, abortSignal) {
    let sent = false
    try {
      await Promise.resolve(); this.beforeSend(); abortSignal.throwIfAborted(); this.assertCurrent(operation)
      assert(this.approved.has(operation)); assert(!this.attempted.has(operation))
      this.approved.delete(operation); this.attempted.add(operation)
      const request = mcpOperationRequest(operation); this.sent.push(request); sent = true
      if (this.outcome === 'unknown') throw new Error('Synthetic lost response')
      return projectMcpResult('docs', request.method, request.params.uri, { contents: [{ uri: request.params.uri, text: 'Untrusted fixture result' }] }, permit)
    } catch { if (sent) this.connected = false; return mcpFailure('fixture_withheld', 'Synthetic request outcome', sent) }
  }
}
class DesktopHost extends CliHost {
  activeRun = 'run-1'
  assertCurrent(operation) { assert.equal(this.activeRun, 'run-1'); super.assertCurrent(operation) }
}
async function subject(Host = CliHost, options = {}) {
  const s = await snapshot(options.template), host = new Host(s), reviews = []
  const review = async (operation, abortSignal) => { reviews.push(operation); if (options.deny) return mcpFailure('denied', 'Synthetic denial'); host.approved.add(operation); return host.invoke(operation, abortSignal) }
  const extension = createMcpExtension(host, [s], review, { validateSchema: compiler, assertAllowed: permit, expandTemplate: expand, ...options.extension })
  const registry = createToolRegistry([extension])
  return { s, host, reviews, extension, registry, execute: c => registry.executeTool(c ?? call(), { signal: signal() }) }
}
for (const Host of [CliHost, DesktopHost]) test(`${Host.name} reads exactly the expanded URI after review and refuses one-shot replay`, async () => {
  const s = await subject(Host)
  const metadata = JSON.parse((await s.execute({ id: 'list', name: 'list_mcp_resources', arguments: {} })).content)
  assert.equal(metadata.servers[0].templates[0].metadataOnly, false)
  assert.deepEqual(metadata.servers[0].templates[0].variables, ['id', 'q'])
  assert.equal(s.host.sent.length, 0); assert.equal(s.reviews.length, 0)
  const result = JSON.parse((await s.execute()).content)
  assert.equal(result.remoteKey, 'docs://items/a%2Fb%20%F0%9F%98%80?q=x%26y')
  assert.equal(result.untrusted, true); assert.equal(s.reviews.length, 1)
  assert.deepEqual(s.host.sent, [{ method: 'resources/read', params: { uri: result.remoteKey } }])
  assert.equal((await s.host.invoke(s.reviews[0], signal())).isError, true); assert.equal(s.host.sent.length, 1)
})

test('template opt-in and metadata-only capability preserve concrete reads and zero-send defaults', async () => {
  for (const extension of [{ expandTemplate: undefined }, { operationsEnabled: false }]) {
    const s = await subject(CliHost, { extension })
    assert.equal(s.registry.has('read_mcp_resource_template'), false)
    const list = JSON.parse((await s.execute({ id: 'list', name: 'list_mcp_resources', arguments: {} })).content)
    assert.equal(list.servers[0].templates[0].metadataOnly, true)
    assert.equal(s.host.sent.length, 0)
    assert.equal(s.registry.has('read_mcp_resource'), extension.operationsEnabled !== false)
  }
  const s = await subject()
  assert.equal((await s.execute({ id: 'read', name: 'read_mcp_resource', arguments: { serverId: 'docs', uri: 'docs://items/x?q=y' } })).isError, true)
  assert.equal(s.reviews.length, 0)
  const result = await s.execute({ id: 'read', name: 'read_mcp_resource', arguments: { serverId: 'docs', uri: 'docs://exact' } })
  assert.equal(result.isError, undefined); assert.deepEqual(s.host.sent[0].params, { uri: 'docs://exact' })
})

test('template denial, stale final send, invalid arguments and active-run cancellation send nothing', async () => {
  const denied = await subject(CliHost, { deny: true }); assert.equal(JSON.parse((await denied.execute()).content).error.code, 'denied'); assert.equal(denied.host.sent.length, 0)
  for (const Host of [CliHost, DesktopHost]) {
    const s = await subject(Host)
    s.host.beforeSend = () => { if (s.host instanceof DesktopHost) s.host.activeRun = 'run-2'; else s.s.catalogGeneration++ }
    assert.equal((await s.execute()).isError, true); assert.equal(s.reviews.length, 1); assert.equal(s.host.sent.length, 0)
  }
  const s = await subject()
  for (const c of [call({ id: 'x' }), call({ id: 'x', q: 'y', extra: 'z' }), call({ id: [], q: 'y' }), call({ id: 'x', q: 'y' }, 'docs://{unknown}'), { ...call(), arguments: { ...call().arguments, extra: true } }]) assert.equal((await s.execute(c)).isError, true)
  assert.equal(s.reviews.length, 0); assert.equal(s.host.sent.length, 0)
})

test('privacy applies to template descriptors, exact values and expanded URI before review', async () => {
  for (const assertAllowed of [value => { if (JSON.stringify(value).includes('a/b')) throw new Error('value withheld') }, value => { if (JSON.stringify(value).includes('a%2Fb')) throw new Error('URI withheld') }]) {
    const s = await subject(CliHost, { extension: { assertAllowed } }); assert.equal((await s.execute()).isError, true); assert.equal(s.reviews.length, 0)
  }
  const s = await subject(CliHost, { extension: { assertAllowed: value => { if (JSON.stringify(value).includes('Items')) throw new Error('descriptor withheld') } } })
  assert.equal(s.registry.has('read_mcp_resource_template'), false)
})

test('template results reject the catalog template and preserve unknown outcomes without replay', async () => {
  const s = await subject(); s.host.outcome = 'unknown'
  const result = JSON.parse((await s.execute()).content)
  assert.equal(result.unknownOutcome, true); assert.equal(result.doNotRetry, true); assert.equal(s.host.sent.length, 1)
  assert.equal((await s.execute({ ...call(), id: 'again' })).isError, true); assert.equal(s.host.sent.length, 1)
  const operation = prepare(await snapshot())
  assert.throws(() => projectMcpResult('docs', 'resources/read', operation.resourceUri, { contents: [{ uri: operation.remoteKey, text: 'wrong identity' }] }, permit), /approved URI/)
})

test('new pure template exports are available through CommonJS', () => {
  const cjs = createRequire(import.meta.url)('../dist/cjs/extensions/mcp.js')
  assert.deepEqual(cjs.mcpTemplateVariables('docs://{id}'), ['id'])
  assert.equal(cjs.expandMcpResourceTemplate('docs://{id}', { id: 'x/y' }, expand), 'docs://x%2Fy')
})
