// SPDX-License-Identifier: Apache-2.0
// Offline only: synthetic schema, captured metadata and an explicit fake host response.
import assert from 'node:assert/strict'
import { createToolRegistry } from '../dist/extensions.js'
import { collectMcpCategory, createMcpExtension, emptyMcpCategory, prepareMcpOperation,
  assertMcpOperationCurrent, projectMcpResult } from '../dist/extensions/mcp.js'

const signal = new AbortController().signal
const schema = { type: 'object', properties: { query: { type: 'string', minLength: 1 } },
  required: ['query'], additionalProperties: false }
// This fixture compiler accepts one known schema only. Real hosts supply a schema engine.
const validateSchema = value => {
  assert.deepEqual(value, schema)
  return arguments_ => {
    assert.equal(Object.keys(arguments_).join(','), 'query')
    assert.equal(typeof arguments_.query, 'string')
    assert(arguments_.query.length > 0)
  }
}
const tools = await collectMcpCategory('docs', 'tools', async () => ({
  tools: [{ name: 'lookup/name', description: 'Untrusted synthetic metadata', inputSchema: schema }]
}), signal, validateSchema)
const snapshot = { serverId: 'docs', configRevision: 'config-1', connectionGeneration: 'connection-1',
  protocolVersion: '2026-07-28', catalogGeneration: 1,
  categories: { tools, resources: emptyMcpCategory(), resourceTemplates: emptyMcpCategory() } }
const host = {
  async captureCatalogs() { return [snapshot] },
  prepareOperation(captured, entry, kind, call) {
    const operation = prepareMcpOperation(captured, entry, kind, call, 'launch-1', validateSchema)
    assertMcpOperationCurrent(operation, snapshot, 'launch-1', true, 'config-1')
    return operation
  }
}
let reviewed = 0
const reviewOperation = async (operation, abortSignal) => {
  abortSignal.throwIfAborted()
  reviewed++
  // Stand-in for this host's exact human approval and actual-send checks. No request is sent.
  assertMcpOperationCurrent(operation, snapshot, 'launch-1', true, 'config-1')
  return projectMcpResult(operation.serverId, 'tools/call', operation.remoteKey,
    { content: [{ type: 'text', text: 'Synthetic lookup result' }] }, () => {})
}
const registry = createToolRegistry([createMcpExtension(host, [snapshot], reviewOperation, {
  validateSchema, assertAllowed() {}
})])
const result = await registry.executeTool({ id: 'lookup-1', name: tools.entries[0].alias,
  arguments: { query: 'offline' } }, { signal })
assert.equal(reviewed, 1)
assert.equal(JSON.parse(result.content).untrusted, true)
console.log('MCP bridge:', JSON.parse(result.content).content[0].text)
