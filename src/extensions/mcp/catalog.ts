// SPDX-License-Identifier: Apache-2.0
// Derived from vivi-cli c748317cb87a72f4e023cc21b96e793ea89e3170, src/mcp-catalog.ts.
// SDK compilation and transport ownership are injected host responsibilities.
import { createHash } from 'node:crypto'
import type { JsonObject } from '../../types.js'
import { assertMcpHostCheck, assertMcpJson, mcpDigest, mcpFreeze, mcpRecord, mcpText } from './data.js'

export const MCP_LIMITS = Object.freeze({ pages: 16, entries: 256, bytes: 1024 * 1024,
  descriptorBytes: 64 * 1024, cursorBytes: 4096, depth: 32, nodes: 4096, categoryMs: 10000, pageMs: 5000 })
export type McpCatalogKind = 'tools' | 'resources' | 'resourceTemplates'
/** Compile synchronously without I/O; assertions throw on rejection and return undefined on success. */
export type McpSchemaValidator = (schema: Readonly<Record<string, unknown>>) => (arguments_: Readonly<JsonObject>) => void
export interface McpCatalogEntry {
  readonly remoteKey: string
  readonly alias: string
  readonly descriptor: Readonly<Record<string, unknown>>
  readonly state: 'available' | 'quarantined'
  readonly reason?: string
}
export interface McpCategory {
  readonly state: 'not-requested' | 'unsupported' | 'ready' | 'stale' | 'error'
  readonly entries: readonly McpCatalogEntry[]
  readonly digest: string
  readonly reason?: string
}
export interface McpCatalogSnapshot {
  readonly serverId: string
  readonly configRevision: string
  readonly connectionGeneration: string
  readonly protocolVersion: string
  readonly catalogGeneration: number
  readonly categories: Readonly<Record<McpCatalogKind, McpCategory>>
}
const listKey = { tools: 'tools', resources: 'resources', resourceTemplates: 'resourceTemplates' } as const
function localServerId(serverId: string): void {
  if (typeof serverId !== 'string' || !/^[a-z][a-z0-9_-]{0,15}$/.test(serverId)) throw new Error('Invalid local MCP server ID')
}
export function mcpAlias(serverId: string, kind: McpCatalogKind, remoteKey: string): string {
  localServerId(serverId)
  if (!Object.hasOwn(listKey, kind) || !mcpText(remoteKey, kind === 'tools' ? 256 : 4096)) throw new Error('Invalid MCP alias identity')
  // Authority is a local ID, never a server-supplied name. Domain separation prevents kind collisions.
  return `mcp_${serverId}_${createHash('sha256').update(JSON.stringify([kind, remoteKey])).digest('hex').slice(0, 32)}`
}
export function emptyMcpCategory(state: McpCategory['state'] = 'not-requested'): McpCategory {
  if (!['not-requested', 'unsupported', 'ready', 'stale', 'error'].includes(state)) throw new Error('Invalid MCP category state')
  return mcpFreeze({ state, entries: [], digest: mcpDigest([]) })
}

/** Capture a bounded schema and enforce the synchronous host assertion contract. */
export function compileMcpSchema(schema: Readonly<Record<string, unknown>>, validateSchema: McpSchemaValidator): (arguments_: Readonly<JsonObject>) => void {
  assertMcpJson(schema, MCP_LIMITS.descriptorBytes)
  if (!mcpRecord(schema) || typeof validateSchema !== 'function') throw new Error('Invalid MCP schema compiler')
  const reason = schemaReason(schema)
  if (reason) throw new Error(reason)
  const validate: unknown = validateSchema(mcpFreeze(structuredClone(schema)))
  if (typeof validate !== 'function') {
    if (validate instanceof Promise) void validate.catch(() => undefined)
    throw new Error('MCP schema compiler must return a synchronous assertion')
  }
  return arguments_ => { assertMcpHostCheck(() => validate(arguments_)) }
}
const keywords = new Set(['$schema', '$id', '$ref', '$defs', 'definitions', '$comment', 'title', 'description', 'type',
  'properties', 'required', 'additionalProperties', 'items', 'prefixItems', 'additionalItems', 'enum', 'const', 'allOf', 'anyOf', 'oneOf', 'not',
  'if', 'then', 'else', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength',
  'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'default', 'examples', 'readOnly', 'writeOnly', 'deprecated'])
function schemaReason(value: unknown, root = true): string | undefined {
  if (typeof value === 'boolean' && !root) return undefined
  if (!mcpRecord(value)) return 'Schema is not an object'
  if (value.$schema !== undefined && (typeof value.$schema !== 'string' || !['https://json-schema.org/draft/2020-12/schema', 'http://json-schema.org/draft-07/schema#',
    'https://json-schema.org/draft/2019-09/schema', 'http://json-schema.org/draft-06/schema#'].includes(value.$schema))) return 'Unsupported schema dialect'
  const types = ['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']
  if (value.type !== undefined && !(typeof value.type === 'string' ? types.includes(value.type)
    : Array.isArray(value.type) && value.type.length > 0 && value.type.length <= types.length &&
      value.type.every(type => typeof type === 'string' && types.includes(type)) && new Set(value.type).size === value.type.length)) return 'Invalid schema type'
  for (const [key, child] of Object.entries(value)) {
    if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'].includes(key) &&
      (typeof child !== 'number' || !Number.isFinite(child) || key === 'multipleOf' && child <= 0)) return 'Invalid numeric schema constraint'
    if (['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'].includes(key) &&
      (typeof child !== 'number' || !Number.isSafeInteger(child) || child < 0)) return 'Invalid size schema constraint'
    if (['uniqueItems', 'readOnly', 'writeOnly', 'deprecated'].includes(key) && typeof child !== 'boolean') return 'Invalid boolean schema constraint'
    if (['title', 'description', '$comment', '$schema'].includes(key) && typeof child !== 'string') return 'Invalid schema metadata'
    if (key === 'required' && (!Array.isArray(child) || child.length > 256 || !child.every(value => typeof value === 'string') || new Set(child).size !== child.length)) return 'Invalid required schema fields'
    if (key === 'enum' && (!Array.isArray(child) || child.length === 0 || child.length > 256 || new Set(child.map(value => mcpDigest(value))).size !== child.length)) return 'Invalid schema enum'
    if (key === 'examples' && !Array.isArray(child)) return 'Invalid schema examples'
    if (!keywords.has(key)) return key === 'x-mcp-header' ? 'Header declarations are unavailable in bounded discovery' : 'Unsupported schema keyword'
    if (['$id', '$ref', '$defs', 'definitions', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'prefixItems'].includes(key)) return 'Referenced or compound schemas are unavailable in discovery'
    if (key === 'properties') {
      if (!mcpRecord(child)) return 'Malformed schema map'
      for (const nested of Object.values(child)) { const reason = schemaReason(nested, false); if (reason) return reason }
    } else if (['items', 'additionalItems', 'additionalProperties'].includes(key)) {
      if (Array.isArray(child)) return 'Tuple schemas are unavailable in discovery'
      const reason = schemaReason(child, false); if (reason) return reason
    }
  }
  return undefined
}
function toolReason(descriptor: Record<string, unknown>, validateSchema: McpSchemaValidator): string | undefined {
  if (mcpRecord(descriptor.execution) && descriptor.execution.taskSupport === 'required') return 'Required task execution is unavailable'
  if (descriptor['x-mcp-header'] !== undefined) return 'Header declarations are unavailable in bounded discovery'
  if (!mcpRecord(descriptor.inputSchema) || descriptor.inputSchema.type !== 'object') return 'Tool input schema must have object type'
  for (const schema of [descriptor.inputSchema, ...(descriptor.outputSchema === undefined ? [] : [descriptor.outputSchema])]) {
    const reason = schemaReason(schema); if (reason) return reason
    try { compileMcpSchema(schema as Readonly<Record<string, unknown>>, validateSchema) } catch { return 'Invalid schema' }
  }
  return undefined
}

async function boundedPage(readPage: (cursor: string | undefined, signal: AbortSignal) => Promise<unknown>,
  cursor: string | undefined, signal: AbortSignal, remainingMs: number): Promise<unknown> {
  signal.throwIfAborted()
  if (remainingMs <= 0) throw new Error('MCP catalog discovery deadline exceeded')
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal])
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(combined.reason)
    combined.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => controller.abort(new Error('MCP catalog page deadline exceeded')), Math.min(MCP_LIMITS.pageMs, remainingMs))
  })
  try { return await Promise.race([Promise.resolve().then(() => { combined.throwIfAborted(); return readPage(cursor, combined) }), stopped]) }
  finally {
    clearTimeout(timer)
    if (abort) combined.removeEventListener('abort', abort)
  }
}

/** One request per page, with an omitted first cursor and a locally enforced deadline. */
export async function collectMcpCategory(serverId: string, kind: McpCatalogKind,
  readPage: (cursor: string | undefined, signal: AbortSignal) => Promise<unknown>, signal: AbortSignal,
  validateSchema: McpSchemaValidator, aliasFor: typeof mcpAlias = mcpAlias): Promise<McpCategory> {
  localServerId(serverId)
  if (!Object.hasOwn(listKey, kind) || typeof readPage !== 'function' || typeof validateSchema !== 'function' || typeof aliasFor !== 'function') throw new Error('Invalid MCP catalog adapter')
  const cursors = new Set<string>(), keys = new Set<string>(), aliases = new Set<string>(), entries: McpCatalogEntry[] = []
  let cursor: string | undefined, bytes = 0
  const deadline = performance.now() + MCP_LIMITS.categoryMs
  const assertTime = (): void => { signal.throwIfAborted(); if (performance.now() >= deadline) throw new Error('MCP catalog discovery deadline exceeded') }
  for (let index = 0; index < MCP_LIMITS.pages; index++) {
    assertTime()
    const raw = await boundedPage(readPage, cursor, signal, deadline - performance.now())
    assertTime()
    // The host bounds wire frames before decoding. We also bound every page field before encoding/compilation.
    assertMcpJson(raw, MCP_LIMITS.bytes - bytes, { nodes: MCP_LIMITS.bytes, depth: MCP_LIMITS.depth + 2 })
    if (!mcpRecord(raw) || !Array.isArray(raw[listKey[kind]])) throw new Error('Malformed MCP catalog page')
    const page = structuredClone(raw), items = page[listKey[kind]] as unknown[]
    bytes += Buffer.byteLength(JSON.stringify(page))
    if (entries.length + items.length > MCP_LIMITS.entries) throw new Error('MCP catalog limit exceeded; category unavailable')
    for (const item of items) {
      assertTime()
      assertMcpJson(item, MCP_LIMITS.descriptorBytes)
      if (!mcpRecord(item)) throw new Error('MCP descriptor must be an object')
      const remoteKey = kind === 'tools' ? item.name : kind === 'resources' ? item.uri : item.uriTemplate
      if (!mcpText(remoteKey, kind === 'tools' ? 256 : 4096) || keys.has(remoteKey)) throw new Error('Invalid or duplicate MCP catalog identity')
      keys.add(remoteKey)
      const alias = aliasFor(serverId, kind, remoteKey)
      if (typeof alias !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(alias) || aliases.has(alias)) throw new Error('MCP catalog alias collision')
      aliases.add(alias)
      const reason = kind === 'tools' ? toolReason(item, validateSchema) : undefined
      assertTime()
      entries.push(mcpFreeze({ remoteKey, alias, descriptor: item, state: reason ? 'quarantined' : 'available', ...(reason ? { reason } : {}) }))
    }
    assertTime()
    if (page.nextCursor === undefined) {
      entries.sort((a, b) => a.remoteKey < b.remoteKey ? -1 : a.remoteKey > b.remoteKey ? 1 : 0)
      assertMcpJson(entries, MCP_LIMITS.bytes, { nodes: MCP_LIMITS.bytes, depth: MCP_LIMITS.depth + 4 })
      assertTime()
      return mcpFreeze({ state: 'ready', entries, digest: mcpDigest(entries) })
    }
    if (!mcpText(page.nextCursor, MCP_LIMITS.cursorBytes) || Buffer.byteLength(page.nextCursor) > MCP_LIMITS.cursorBytes || cursors.has(page.nextCursor)) throw new Error('Invalid or repeated MCP cursor')
    cursors.add(page.nextCursor); cursor = page.nextCursor
  }
  throw new Error('MCP pagination limit exceeded; category unavailable')
}
