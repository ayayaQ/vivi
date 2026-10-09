// SPDX-License-Identifier: Apache-2.0
// Derived from vivi-cli c748317cb87a72f4e023cc21b96e793ea89e3170, src/mcp-content.ts.
// Privacy/credential policy belongs to the required host assertion, not shared session machinery.
import type { ToolResult } from '../../types.js'
import { assertMcpHostCheck, assertMcpJson, mcpFreeze, mcpRecord, mcpText } from './data.js'

export const MCP_OPERATION_LIMITS = Object.freeze({ argumentBytes: 16 * 1024, resultBytes: 64 * 1024,
  projectionBytes: 128 * 1024, tools: 128, contentItems: 128, operationMs: 10000 })
export function mcpFailure(code: string, message: string, unknownOutcome = false): ToolResult {
  if (typeof code !== 'string' || typeof message !== 'string' || typeof unknownOutcome !== 'boolean') throw new Error('Invalid MCP failure projection')
  const projection = { success: false, source: 'mcp', untrusted: true,
    ...(unknownOutcome ? { unknownOutcome: true, doNotRetry: true } : {}), error: { code, message } }
  assertMcpJson(projection, MCP_OPERATION_LIMITS.resultBytes)
  return { content: JSON.stringify(projection), isError: true }
}

/** Foreign result families never become empty successes through compatibility normalization. */
export function assertMcpOperationResult(method: 'tools/call' | 'resources/read', result: unknown): void {
  if (method !== 'tools/call' && method !== 'resources/read') throw new Error('Unsupported MCP operation method')
  assertMcpJson(result, MCP_OPERATION_LIMITS.resultBytes)
  if (!mcpRecord(result) || ['task', 'inputRequests', 'requestState', 'toolResult'].some(key => Object.hasOwn(result, key)) ||
    result.resultType !== undefined && result.resultType !== 'complete') throw new Error('Unsupported MCP result envelope')
  const content = result[method === 'tools/call' ? 'content' : 'contents']
  if (!Array.isArray(content) || content.length > MCP_OPERATION_LIMITS.contentItems ||
    result.isError !== undefined && typeof result.isError !== 'boolean') throw new Error('Invalid MCP result content')
}
function textResource(value: unknown): Record<string, unknown> {
  if (!mcpRecord(value) || typeof value.uri !== 'string') throw new Error('Invalid MCP resource content')
  return { uri: value.uri, ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}),
    ...(typeof value.text === 'string' ? { text: value.text } : { binaryOmitted: true }) }
}

/** Bounded untrusted text only. Binary is omitted; resource links remain data and are never fetched. */
export function projectMcpResult(serverId: string, method: 'tools/call' | 'resources/read', remoteKey: string,
  result: unknown, assertAllowed: (value: unknown) => void): ToolResult {
  if (typeof serverId !== 'string' || !/^[a-z][a-z0-9_-]{0,15}$/.test(serverId) ||
    !mcpText(remoteKey, method === 'tools/call' ? 256 : 4096) || typeof assertAllowed !== 'function') throw new Error('Invalid MCP result projection host')
  assertMcpOperationResult(method, result)
  // The policy receives a frozen clone, so it cannot mutate admitted result data after validation.
  const body = mcpFreeze(structuredClone(result)) as Record<string, unknown>
  assertMcpHostCheck(() => assertAllowed(body))
  let content: Record<string, unknown>[]
  if (method === 'resources/read') {
    content = (body.contents as unknown[]).map(item => {
      const resource = textResource(item)
      if (resource.uri !== remoteKey) throw new Error('MCP resource URI differs from the approved URI')
      return resource
    })
  } else content = (body.content as unknown[]).map(item => {
    if (!mcpRecord(item) || typeof item.type !== 'string') throw new Error('Invalid MCP content block')
    if (item.type === 'text' && typeof item.text === 'string') return { type: 'text', text: item.text }
    if (item.type === 'resource') return { type: 'resource', resource: textResource(item.resource) }
    if (item.type === 'resource_link' && typeof item.uri === 'string') return { type: 'resource_link', uri: item.uri,
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(typeof item.description === 'string' ? { description: item.description } : {}) }
    if (item.type === 'image' || item.type === 'audio') return { type: item.type, binaryOmitted: true,
      ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}) }
    throw new Error('Unsupported MCP content block')
  })
  const projection = { success: body.isError !== true, source: 'mcp', untrusted: true, serverId,
    method, remoteKey, content, ...(Object.hasOwn(body, 'structuredContent') ? { structuredContent: body.structuredContent } : {}) }
  assertMcpJson(projection, MCP_OPERATION_LIMITS.resultBytes)
  return { content: JSON.stringify(projection), ...(body.isError === true ? { isError: true } : {}) }
}
