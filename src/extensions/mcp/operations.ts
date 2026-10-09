// SPDX-License-Identifier: Apache-2.0
// Derived from vivi-cli c748317cb87a72f4e023cc21b96e793ea89e3170, src/mcp-manager.ts.
// These pure preparation/comparison helpers grant no approval, connection ownership or send guarantee.
import type { JsonObject, ToolCall } from '../../types.js'
import { compileMcpSchema, MCP_LIMITS } from './catalog.js'
import type { McpCatalogEntry, McpCatalogSnapshot, McpSchemaValidator } from './catalog.js'
import { MCP_OPERATION_LIMITS } from './content.js'
import { assertMcpJson, mcpDigest, mcpFreeze, mcpRecord, mcpText } from './data.js'

export interface McpPreparedOperation {
  readonly call: ToolCall
  readonly serverId: string
  readonly catalogKind: 'tools' | 'resources'
  readonly remoteKey: string
  readonly descriptor: Readonly<Record<string, unknown>>
  readonly snapshot: McpCatalogSnapshot
  readonly binding: JsonObject
}
const bindingKeys = ['serverId', 'configRevision', 'connectionGeneration', 'protocolVersion', 'catalogGeneration',
  'categoryDigest', 'descriptorDigest', 'launchDigest', 'operationDigest'] as const
const kinds = ['tools', 'resources', 'resourceTemplates'] as const
const snapshotBytes = 3 * MCP_LIMITS.bytes + 256 * 1024
const snapshotLimits = { nodes: 8 * 1024 * 1024, depth: 48 } as const

export function assertMcpCatalogSnapshot(snapshot: unknown): asserts snapshot is McpCatalogSnapshot {
  assertMcpJson(snapshot, snapshotBytes, snapshotLimits)
  if (!mcpRecord(snapshot) || typeof snapshot.serverId !== 'string' || !/^[a-z][a-z0-9_-]{0,15}$/.test(snapshot.serverId) ||
    !mcpText(snapshot.configRevision, 4096) || !mcpText(snapshot.connectionGeneration, 4096) || !mcpText(snapshot.protocolVersion, 128) ||
    !Number.isSafeInteger(snapshot.catalogGeneration) || (snapshot.catalogGeneration as number) < 0 || !mcpRecord(snapshot.categories) ||
    Object.keys(snapshot.categories).length !== kinds.length || !kinds.every(kind => Object.hasOwn(snapshot.categories as object, kind))) throw new Error('Invalid MCP catalog snapshot')
  for (const kind of kinds) {
    const category = snapshot.categories[kind]
    if (!mcpRecord(category) || !['not-requested', 'unsupported', 'ready', 'stale', 'error'].includes(category.state as string) ||
      !Array.isArray(category.entries) || category.entries.length > MCP_LIMITS.entries || category.digest !== mcpDigest(category.entries)) throw new Error('Invalid MCP catalog category')
    assertMcpJson(category.entries, MCP_LIMITS.bytes, { nodes: MCP_LIMITS.bytes, depth: MCP_LIMITS.depth + 4 })
    const keys = new Set<string>(), aliases = new Set<string>()
    for (const entry of category.entries) {
      if (!mcpRecord(entry) || !mcpText(entry.remoteKey, kind === 'tools' ? 256 : 4096) || typeof entry.alias !== 'string' ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(entry.alias) || !mcpRecord(entry.descriptor) || !['available', 'quarantined'].includes(entry.state as string) ||
        keys.has(entry.remoteKey) || aliases.has(entry.alias)) throw new Error('Invalid MCP catalog entry')
      assertMcpJson(entry.descriptor, MCP_LIMITS.descriptorBytes)
      const descriptorKey = kind === 'tools' ? entry.descriptor.name : kind === 'resources' ? entry.descriptor.uri : entry.descriptor.uriTemplate
      if (descriptorKey !== entry.remoteKey) throw new Error('MCP descriptor differs from its catalog identity')
      keys.add(entry.remoteKey); aliases.add(entry.alias)
    }
  }
}
function assertCall(call: unknown): asserts call is ToolCall {
  assertMcpJson(call, MCP_OPERATION_LIMITS.argumentBytes + 1024)
  if (!mcpRecord(call) || Object.keys(call).length !== 3 || !mcpText(call.id, 1024) || !mcpText(call.name, 64) || !mcpRecord(call.arguments)) throw new Error('Invalid MCP tool call')
  assertMcpJson(call.arguments, MCP_OPERATION_LIMITS.argumentBytes)
}
function assertSelection(snapshot: McpCatalogSnapshot, entry: McpCatalogEntry, kind: 'tools' | 'resources', call: ToolCall): void {
  if (kind !== 'tools' && kind !== 'resources' || snapshot.categories[kind].state !== 'ready' ||
    !snapshot.categories[kind].entries.includes(entry) || entry.state !== 'available') throw new Error('MCP catalog entry is unavailable')
  if (kind === 'tools') {
    if (call.name !== entry.alias || !mcpRecord(entry.descriptor.inputSchema) || entry.descriptor.inputSchema.type !== 'object') throw new Error('MCP tool call differs from the captured alias or schema')
  } else if (call.name !== 'read_mcp_resource' || Object.keys(call.arguments).sort().join(',') !== 'serverId,uri' ||
    call.arguments.serverId !== snapshot.serverId || call.arguments.uri !== entry.remoteKey) throw new Error('MCP resource selection differs from the captured URI')
}
function capturedOperation(operation: McpPreparedOperation) {
  return { call: operation.call, serverId: operation.serverId, catalogKind: operation.catalogKind,
    remoteKey: operation.remoteKey, descriptor: operation.descriptor, snapshot: operation.snapshot }
}
function assertPrepared(operation: McpPreparedOperation): void {
  assertMcpJson(operation, snapshotBytes + MCP_LIMITS.descriptorBytes + MCP_OPERATION_LIMITS.argumentBytes + 4096, snapshotLimits)
  assertMcpCatalogSnapshot(operation.snapshot); assertCall(operation.call)
  if (operation.catalogKind !== 'tools' && operation.catalogKind !== 'resources' || operation.serverId !== operation.snapshot.serverId ||
    !mcpRecord(operation.binding) || Object.keys(operation.binding).length !== bindingKeys.length ||
    !bindingKeys.every(key => Object.hasOwn(operation.binding, key))) throw new Error('Invalid MCP prepared operation binding')
  const entry = operation.snapshot.categories[operation.catalogKind].entries.find(value => value.remoteKey === operation.remoteKey)
  if (!entry || mcpDigest(entry.descriptor) !== mcpDigest(operation.descriptor)) throw new Error('MCP operation descriptor differs from its captured entry')
  assertSelection(operation.snapshot, entry, operation.catalogKind, operation.call)
}

/** Capture one exact local proposal. Host policy must separately approve, recheck and send it. */
export function prepareMcpOperation(snapshot: McpCatalogSnapshot, entry: McpCatalogEntry,
  kind: 'tools' | 'resources', call: ToolCall, launchDigest: string, validateSchema: McpSchemaValidator): McpPreparedOperation {
  assertMcpCatalogSnapshot(snapshot); assertCall(call)
  if (!mcpText(launchDigest, 4096) || typeof validateSchema !== 'function') throw new Error('Invalid MCP operation host identity')
  assertSelection(snapshot, entry, kind, call)
  // Callers and compiler adapters cannot alter the captured approval data after this point.
  const capturedSnapshot = mcpFreeze(structuredClone(snapshot)), capturedCall = mcpFreeze(structuredClone(call))
  const capturedEntry = capturedSnapshot.categories[kind].entries.find(value => value.remoteKey === entry.remoteKey)!
  if (kind === 'tools') {
    if (mcpRecord(capturedEntry.descriptor.execution) && capturedEntry.descriptor.execution.taskSupport === 'required') throw new Error('Required task execution is unavailable')
    if (capturedEntry.descriptor['x-mcp-header'] !== undefined) throw new Error('Header declarations are unavailable in bounded discovery')
    if (capturedEntry.descriptor.outputSchema !== undefined) compileMcpSchema(capturedEntry.descriptor.outputSchema as Readonly<Record<string, unknown>>, validateSchema)
    compileMcpSchema(capturedEntry.descriptor.inputSchema as Readonly<Record<string, unknown>>, validateSchema)(capturedCall.arguments)
  }
  const captured = { call: capturedCall, serverId: capturedSnapshot.serverId, catalogKind: kind, remoteKey: capturedEntry.remoteKey,
    descriptor: capturedEntry.descriptor, snapshot: capturedSnapshot }
  const binding: JsonObject = { serverId: capturedSnapshot.serverId, configRevision: capturedSnapshot.configRevision,
    connectionGeneration: capturedSnapshot.connectionGeneration, protocolVersion: capturedSnapshot.protocolVersion,
    catalogGeneration: capturedSnapshot.catalogGeneration, categoryDigest: capturedSnapshot.categories[kind].digest,
    descriptorDigest: mcpDigest(capturedEntry.descriptor), launchDigest, operationDigest: mcpDigest(captured) }
  return mcpFreeze({ ...captured, binding })
}

/** Revision evidence for a host prepared-action review. It is neither approval nor a freshness lease. */
export function mcpOperationRevisions(operation: McpPreparedOperation, currentSnapshot: McpCatalogSnapshot | undefined,
  launchDigest: string, connected: boolean, configRevision: string): JsonObject {
  assertPrepared(operation)
  if (currentSnapshot !== undefined) assertMcpCatalogSnapshot(currentSnapshot)
  if (typeof connected !== 'boolean' || typeof launchDigest !== 'string' || typeof configRevision !== 'string') throw new Error('Invalid MCP host revision state')
  const category = currentSnapshot?.categories[operation.catalogKind]
  const entry = category?.entries.find(value => value.remoteKey === operation.remoteKey)
  return mcpFreeze({ serverId: currentSnapshot?.serverId ?? operation.serverId, configRevision,
    connectionGeneration: currentSnapshot?.connectionGeneration ?? '', protocolVersion: currentSnapshot?.protocolVersion ?? '',
    catalogGeneration: currentSnapshot?.catalogGeneration ?? -1, categoryDigest: category?.digest ?? '',
    descriptorDigest: mcpDigest(entry?.descriptor ?? null), launchDigest,
    operationDigest: mcpDigest(capturedOperation(operation)), connected, categoryReady: category?.state === 'ready',
    bindingDigest: mcpDigest(operation.binding) })
}

/** Fail closed on every CLI binding field; the host still owns the final-send recheck and revocation. */
export function assertMcpOperationCurrent(operation: McpPreparedOperation, currentSnapshot: McpCatalogSnapshot | undefined,
  launchDigest: string, connected: boolean, configRevision: string): void {
  const current = mcpOperationRevisions(operation, currentSnapshot, launchDigest, connected, configRevision)
  if (!current.connected || !current.categoryReady || currentSnapshot?.configRevision !== configRevision || !mcpText(launchDigest, 4096) ||
    bindingKeys.some(key => current[key] !== operation.binding[key])) throw new Error('MCP operation became stale; request fresh approval after metadata refresh')
}
