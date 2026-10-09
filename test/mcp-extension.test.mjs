// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv'
import { createToolRegistry } from '../dist/extensions.js'
import { createMcpExtension, collectMcpCategory, emptyMcpCategory, prepareMcpOperation,
  assertMcpOperationCurrent, mcpOperationRevisions, projectMcpResult, mcpFailure,
  MCP_RESOURCE_TOOL_NAMES } from '../dist/extensions/mcp.js'

const signal = () => new AbortController().signal
const validateSchema = schema => {
  const validate = new AjvJsonSchemaValidator().getValidator(schema)
  return arguments_ => { if (!validate(arguments_).valid) throw new Error('Invalid fixture arguments') }
}
const schema = { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 20 },
  count: { type: 'integer', minimum: 0, maximum: 2 } }, required: ['query'], additionalProperties: false }
const assertAllowed = value => { if (JSON.stringify(value).includes('offline-credential-marker')) throw new Error('Withheld by host privacy policy') }

// The shape is the CLI's current public manager seam, with an owned fake request sink.
// Desktop adds an active session/run permit at the same seam. No production host adoption is implied.
class CliAdapter {
  snapshot; launchDigest = 'launch-1'; configRevision = 'config-1'; connected = true
  sent = []; approved = new WeakSet(); attempted = new WeakSet(); outcome = 'complete'; beforeSend = () => {}
  constructor(snapshot) { this.snapshot = snapshot }
  async captureCatalogs(abortSignal) { abortSignal.throwIfAborted(); return this.connected ? [this.snapshot] : [] }
  prepareOperation(snapshot, entry, kind, call) {
    const operation = prepareMcpOperation(snapshot, entry, kind, call, this.launchDigest, validateSchema)
    this.assertCurrent(operation); return operation
  }
  operationRevisions(operation) { return mcpOperationRevisions(operation, this.snapshot, this.launchDigest, this.connected, this.configRevision) }
  assertCurrent(operation) { assertMcpOperationCurrent(operation, this.snapshot, this.launchDigest, this.connected, this.configRevision) }
  async invoke(operation, abortSignal, assertActiveRun) {
    let sent = false
    try {
      // The host consumes approval at its fake final-send boundary, after asynchronous setup.
      await Promise.resolve(); this.beforeSend()
      abortSignal.throwIfAborted(); assertActiveRun(); this.assertCurrent(operation)
      assert(this.approved.has(operation)); assert(!this.attempted.has(operation))
      this.attempted.add(operation); this.approved.delete(operation)
      this.sent.push({ method: operation.catalogKind === 'tools' ? 'tools/call' : 'resources/read',
        params: operation.catalogKind === 'tools' ? { name: operation.remoteKey, arguments: operation.call.arguments } : { uri: operation.remoteKey } })
      sent = true
      if (this.outcome === 'unknown') throw new Error('Synthetic lost response')
      abortSignal.throwIfAborted(); assertActiveRun(); this.assertCurrent(operation)
      return projectMcpResult(operation.serverId, operation.catalogKind === 'tools' ? 'tools/call' : 'resources/read', operation.remoteKey,
        operation.catalogKind === 'tools' ? { content: [{ type: 'text', text: 'Synthetic result' }] }
          : { contents: [{ uri: operation.remoteKey, text: 'Synthetic resource' }] }, assertAllowed)
    } catch {
      if (sent) { this.connected = false; return mcpFailure('mcp_unknown_outcome', 'Check the external outcome', true) }
      return mcpFailure('mcp_unavailable', 'Request was withheld')
    }
  }
}
class DesktopAdapter extends CliAdapter {
  activeRun = 'run-1'; mode = 'Manual'
  assertActiveRun(run) { assert.equal(this.activeRun, run) }
}
async function subject(Adapter = CliAdapter, options = {}) {
  const tools = await collectMcpCategory('docs', 'tools', async () => ({ tools: [{ name: 'lookup/name', description: 'Untrusted external guidance', inputSchema: schema }] }), signal(), validateSchema)
  const resources = await collectMcpCategory('docs', 'resources', async () => ({ resources: [{ uri: 'docs://exact', name: 'Exact resource' }] }), signal(), validateSchema)
  const resourceTemplates = await collectMcpCategory('docs', 'resourceTemplates', async () => ({ resourceTemplates: [{ uriTemplate: 'docs://{id}' }] }), signal(), validateSchema)
  const snapshot = { serverId: 'docs', configRevision: 'config-1', connectionGeneration: 'connection-1', protocolVersion: '2026-07-28', catalogGeneration: 1,
    categories: { tools, resources, resourceTemplates } }
  const host = new Adapter(snapshot), reviews = [], capturedRun = 'run-1'
  const review = async (operation, abortSignal) => {
    reviews.push(operation)
    if (options.deny) return mcpFailure('denied', 'Host declined this exact proposal')
    host.approved.add(operation)
    return host.invoke(operation, abortSignal, () => { if (host instanceof DesktopAdapter) host.assertActiveRun(capturedRun) })
  }
  const extension = createMcpExtension(host, [snapshot], review, { validateSchema, assertAllowed, ...options.extension })
  const registry = createToolRegistry([extension])
  const call = { id: 'call-1', name: tools.entries[0].alias, arguments: { query: 'hello', count: 2 } }
  return { host, reviews, snapshot, extension, registry, call,
    execute: call_ => registry.executeTool(call_ ?? call, { signal: signal() }) }
}
for (const Adapter of [CliAdapter, DesktopAdapter]) test(`${Adapter.name} preserves exact names/schema and reviews before its one-shot request`, async () => {
  const s = await subject(Adapter)
  assert.deepEqual(s.registry.tools.find(tool => tool.name === s.call.name).parameters, schema)
  const output = await s.execute()
  assert.equal(JSON.parse(output.content).untrusted, true)
  assert.equal(s.reviews.length, 1); assert.equal(s.host.sent.length, 1)
  assert.deepEqual(s.host.sent[0], { method: 'tools/call', params: { name: 'lookup/name', arguments: s.call.arguments } })
  const replay = await s.host.invoke(s.reviews[0], signal(), () => {})
  assert.equal(replay.isError, true); assert.equal(s.host.sent.length, 1)
})
test('host denial and invalid schema/credential arguments never reach the fake sink', async () => {
  const denied = await subject(CliAdapter, { deny: true })
  assert.equal(JSON.parse((await denied.execute()).content).error.code, 'denied')
  assert.equal(denied.host.sent.length, 0)
  const s = await subject()
  for (const arguments_ of [{}, {query:''}, {query:'hello',count:3}, {query:'hello',other:true}, {query:'offline-credential-marker'}]) {
    assert.equal((await s.execute({...s.call,arguments:arguments_})).isError,true)
  }
  assert.equal(s.reviews.length,0); assert.equal(s.host.sent.length,0)
})
test('local metadata listing never proposes an operation; concrete reads do, templates do not', async () => {
  const s = await subject()
  const list = JSON.parse((await s.execute({id:'list',name:'list_mcp_resources',arguments:{}})).content)
  assert.equal(list.localMetadataOnly,true); assert.equal(list.servers[0].templates[0].metadataOnly,true)
  assert.equal(s.reviews.length,0); assert.equal(s.host.sent.length,0)
  const unknown = await s.execute({id:'read-unknown',name:'read_mcp_resource',arguments:{serverId:'docs',uri:'docs://expanded'}})
  assert.equal(unknown.isError,true); assert.equal(s.reviews.length,0)
  const read = await s.execute({id:'read-exact',name:'read_mcp_resource',arguments:{serverId:'docs',uri:'docs://exact'}})
  assert.equal(JSON.parse(read.content).method,'resources/read'); assert.equal(s.reviews.length,1)
  assert.deepEqual(s.host.sent[0].params,{uri:'docs://exact'})
})
test('metadata-only capability withholds all external operations while local listing remains', async () => {
  const s = await subject(DesktopAdapter,{extension:{operationsEnabled:false}})
  assert.deepEqual(s.registry.tools.map(tool=>tool.name),['list_mcp_resources'])
  await s.execute({id:'list',name:'list_mcp_resources',arguments:{}})
  assert.equal(s.reviews.length,0); assert.equal(s.host.sent.length,0)
})
test('catalog mutation cannot hot-replace definitions or acquire newer local metadata mid-turn', async () => {
  const s = await subject()
  s.snapshot.categories = {...s.snapshot.categories, resources:emptyMcpCategory()}
  assert.equal((await s.execute({id:'list',name:'list_mcp_resources',arguments:{}})).isError,true)
  assert.deepEqual(s.registry.tools.find(tool=>tool.name===s.call.name).parameters,schema)
})
test('actual-send host checks catch launch changes and desktop run cancellation after review', async () => {
  for (const Adapter of [CliAdapter,DesktopAdapter]) {
    const s = await subject(Adapter)
    s.host.beforeSend=()=>{if(s.host instanceof DesktopAdapter)s.host.activeRun='run-2';else s.host.launchDigest='launch-2'}
    assert.equal((await s.execute()).isError,true)
    assert.equal(s.reviews.length,1); assert.equal(s.host.sent.length,0)
  }
})
test('unknown outcomes retain source/untrusted/doNotRetry and disable the fake connection', async () => {
  const s = await subject(DesktopAdapter);s.host.mode='Auto';s.host.outcome='unknown'
  const result = await s.execute(), parsed = JSON.parse(result.content)
  assert.equal(result.isError,true);assert.equal(parsed.source,'mcp');assert.equal(parsed.untrusted,true)
  assert.equal(parsed.unknownOutcome,true);assert.equal(parsed.doNotRetry,true)
  assert.equal(s.reviews.length,1);assert.equal(s.host.sent.length,1);assert.equal(s.host.connected,false)
  assert.equal((await s.execute({...s.call,id:'second'})).isError,true);assert.equal(s.host.sent.length,1)
})
test('mandatory host wiring and synchronous checks reject malformed adapters', async () => {
  const s = await subject()
  assert.throws(()=>createMcpExtension(s.host,[s.snapshot],undefined,{validateSchema,assertAllowed}))
  assert.throws(()=>createMcpExtension(s.host,[s.snapshot],async()=>({content:''}),{validateSchema}))
  const asyncPrivacy = await subject(CliAdapter,{extension:{assertAllowed:async()=>{}}})
  assert.equal(asyncPrivacy.registry.has(asyncPrivacy.call.name),false)
  assert.deepEqual(MCP_RESOURCE_TOOL_NAMES,['list_mcp_resources','read_mcp_resource'])
})

test('a throwing host review cannot become a retryable unavailable result', async () => {
  const s = await subject()
  const extension = createMcpExtension(s.host,[s.snapshot],async()=>{throw new Error('Synthetic lost host response')},{validateSchema,assertAllowed})
  const registry=createToolRegistry([extension])
  const output=JSON.parse((await registry.executeTool(s.call,{signal:signal()})).content)
  assert.equal(output.unknownOutcome,true);assert.equal(output.doNotRetry,true)
  assert.equal(output.error.code,'mcp_review_unconfirmed')
})
test('direct extension execution still rejects wrong aliases and invalid arguments', async () => {
  const s = await subject(), tool=s.extension.tools.find(tool=>tool.definition.name===s.call.name)
  assert.equal((await tool.execute({...s.call,name:'wrong'},{signal:signal()})).isError,true)
  assert.equal((await tool.execute({...s.call,arguments:{query:'hello',count:3}},{signal:signal()})).isError,true)
  assert.equal(s.reviews.length,0);assert.equal(s.host.sent.length,0)
})
