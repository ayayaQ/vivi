// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv'
import { createToolRegistry } from '../dist/extensions.js'
import { runAgent } from '../dist/index.js'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

for (const phase of ['before-send', 'after-send', 'after-send-checkpoint-failure']) {
  test(`host cancellation ledger reconciles persisted/displayed ${phase} results without replay`, async t => {
    const s = await subject(DesktopAdapter), controller = new AbortController(), outcomes = new Map()
    const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-ledger-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const ledgerFile = join(directory, 'attempt.json'), historyFile = join(directory, 'history.json')
    const scope = { sessionId: 'fixture-session', runId: 'run-1' }
    let attempts = 0, checkpointFailed = false
    const withRequestSent = (result, requestSent) => ({ ...result,
      content: JSON.stringify({ ...JSON.parse(result.content), requestSent }) })
    const review = async operation => {
      let result
      if (phase === 'before-send') {
        result = withRequestSent(mcpFailure('mcp_not_attempted', 'Cancelled before the send boundary'), false)
        outcomes.set(operation.call.id, { ...scope, operation, attempted: false, result })
      } else {
        // Durable send intent is conservative evidence of a possibly sent attempt, never approval.
        const attempt = { ...scope, call: operation.call, binding: operation.binding, outcome: 'unconfirmed' }
        await writeFile(ledgerFile, JSON.stringify(attempt))
        outcomes.set(operation.call.id, { ...scope, operation, attempted: true, result: null })
        attempts++ // The fake final transport boundary; no real server exists.
        result = withRequestSent(mcpFailure('mcp_unknown_outcome', 'Response lost after send', true), true)
        outcomes.get(operation.call.id).result = result
        try {
          if (phase === 'after-send-checkpoint-failure') throw new Error('Synthetic outcome checkpoint failure')
          await writeFile(ledgerFile, JSON.stringify({ ...attempt, result }))
        } catch { checkpointFailed = true }
      }
      controller.abort(new Error('Synthetic cancellation'))
      s.host.connected = false
      return result
    }
    const registry = createToolRegistry([createMcpExtension(s.host, [s.snapshot], review, { validateSchema, assertAllowed })])
    const raw = await runAgent({ provider: { async generate() { return { content: '', toolCalls: [s.call] } } },
      messages: [], tools: registry.tools, executeTool: registry.executeTool, signal: controller.signal })
    assert.equal(raw.status, 'cancelled')
    const rawResult = raw.history.find(message => message.kind === 'tool_result' && message.callId === s.call.id)
    assert(rawResult); assert.equal(JSON.parse(rawResult.content).unknownOutcome, undefined)
    await writeFile(historyFile, JSON.stringify(raw.history))
    // Terminal reconciliation is by captured session/run/call/alias, never untrusted result.source.
    const reconciled = raw.history.map(message => {
      if (message.kind !== 'tool_result') return message
      const outcome = outcomes.get(message.callId)
      if (!outcome || outcome.sessionId !== scope.sessionId || outcome.runId !== scope.runId ||
        outcome.operation.call.name !== message.name || !outcome.result) return message
      return { ...message, ...outcome.result }
    })
    if (!checkpointFailed) await writeFile(historyFile, JSON.stringify(reconciled))
    const display = message => {
      const body = JSON.parse(message.content)
      return body.unknownOutcome === true ? 'Outcome unconfirmed; do not retry' :
        body.requestSent === false ? 'Not attempted' : 'Confirmed response'
    }
    const final = reconciled.find(message => message.kind === 'tool_result' && message.callId === s.call.id)
    const expectedLabel = phase === 'before-send' ? 'Not attempted' : 'Outcome unconfirmed; do not retry'
    assert.equal(display(final), expectedLabel)
    // A restart after failed terminal/outcome writes repairs generic cancellation from durable intent.
    const persisted = JSON.parse(await readFile(historyFile, 'utf8'))
    const attempt = phase === 'before-send' ? undefined : JSON.parse(await readFile(ledgerFile, 'utf8'))
    const recovered = persisted.map(message => {
      if (message.kind !== 'tool_result' || !attempt || attempt.sessionId !== scope.sessionId ||
        attempt.runId !== scope.runId || attempt.call.id !== message.callId || attempt.call.name !== message.name) return message
      const result = attempt.result ?? mcpFailure('mcp_unknown_outcome', 'Recorded send intent interrupted before confirmation', true)
      return { ...message, ...result }
    })
    const restored = recovered.find(message => message.kind === 'tool_result' && message.callId === s.call.id)
    assert.equal(display(restored), expectedLabel)
    assert.equal(restored.name, s.call.name); assert.equal(restored.isError, true)
    assert.equal(JSON.parse(restored.content).untrusted, true)
    assert.equal(JSON.parse(restored.content).requestSent, phase === 'before-send' ? false :
      phase === 'after-send-checkpoint-failure' ? undefined : true)
    assert.equal(JSON.parse(restored.content).unknownOutcome === true, phase !== 'before-send')
    assert.equal(JSON.parse(restored.content).doNotRetry === true, phase !== 'before-send')
    assert.deepEqual(recovered.map(message => message.kind === 'tool_result' ? [message.callId, message.name] : message),
      raw.history.map(message => message.kind === 'tool_result' ? [message.callId, message.name] : message))
    assert.equal(attempts, phase === 'before-send' ? 0 : 1)
    assert.equal(checkpointFailed, phase === 'after-send-checkpoint-failure')
    assert.equal(s.host.connected, false)
  })
}
