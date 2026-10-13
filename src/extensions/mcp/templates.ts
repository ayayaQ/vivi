// SPDX-License-Identifier: Apache-2.0
// Bounded scalar RFC 6570 admission only. Expansion is trusted host code, never I/O.
import { assertMcpJson, mcpFreeze, mcpRecord, mcpText } from './data.js'

export const MCP_TEMPLATE_LIMITS = Object.freeze({ uriBytes: 4096, variables: 32, valueBytes: 4096 })
/** Expand synchronously without I/O. Throw on unsupported templates or values. */
export type McpTemplateExpander = (uriTemplate: string, variables: Readonly<Record<string, string>>) => string

/** Level 1–3 scalar expressions; modifiers and percent-encoded variable names are withheld. */
export function mcpTemplateVariables(uriTemplate: string): readonly string[] {
  if (!mcpText(uriTemplate, MCP_TEMPLATE_LIMITS.uriBytes) || Buffer.byteLength(uriTemplate) > MCP_TEMPLATE_LIMITS.uriBytes ||
    !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uriTemplate)) throw new Error('Invalid MCP resource template')
  const variables = new Set<string>()
  let offset = 0
  while (offset < uriTemplate.length) {
    const open = uriTemplate.indexOf('{', offset)
    const literal = uriTemplate.slice(offset, open === -1 ? undefined : open)
    // This slice requires URI-safe ASCII literals. A host must not resolve relative references.
    if (/[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/.test(literal) || /%(?![0-9A-Fa-f]{2})/.test(literal)) throw new Error('Unsupported MCP resource template literal')
    if (open === -1) break
    const close = uriTemplate.indexOf('}', open + 1)
    if (close === -1) throw new Error('Malformed MCP resource template expression')
    const expression = uriTemplate.slice(open + 1, close).replace(/^[+#./;?&]/, '')
    if (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*(?:,[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)*$/.test(expression)) throw new Error('Unsupported MCP resource template expression')
    for (const variable of expression.split(',')) {
      if (variable.length > 64) throw new Error('MCP template variable exceeds its bounds')
      variables.add(variable)
      if (variables.size > MCP_TEMPLATE_LIMITS.variables) throw new Error('MCP template variable limit exceeded')
    }
    offset = close + 1
  }
  if (!variables.size) throw new Error('MCP resource template has no variables')
  return Object.freeze([...variables].sort())
}

export function assertMcpTemplateValues(uriTemplate: string, variables: unknown): asserts variables is Readonly<Record<string, string>> {
  const names = mcpTemplateVariables(uriTemplate)
  assertMcpJson(variables, 16 * 1024)
  if (!mcpRecord(variables) || Object.keys(variables).length !== names.length ||
    !names.every(name => Object.hasOwn(variables, name))) throw new Error('MCP template requires exact variable values')
  for (const value of Object.values(variables)) {
    if (typeof value !== 'string' || value.length > MCP_TEMPLATE_LIMITS.valueBytes || Buffer.byteLength(value) > MCP_TEMPLATE_LIMITS.valueBytes ||
      /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error('Invalid MCP template variable value')
  }
}
export function assertMcpResourceUri(uri: unknown): asserts uri is string {
  if (!mcpText(uri, MCP_TEMPLATE_LIMITS.uriBytes) || Buffer.byteLength(uri) > MCP_TEMPLATE_LIMITS.uriBytes ||
    !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri) || /[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/.test(uri) ||
    /%(?![0-9A-Fa-f]{2})/.test(uri)) throw new Error('MCP template expander must return one bounded absolute URI synchronously')
}
/** Exact required values and one bounded absolute URI, with no normalization or resolution. */
export function expandMcpResourceTemplate(uriTemplate: string, variables: unknown, expand: McpTemplateExpander): string {
  assertMcpTemplateValues(uriTemplate, variables)
  if (typeof expand !== 'function') throw new Error('MCP template requires a host expander')
  const captured = mcpFreeze(structuredClone(variables)) as Readonly<Record<string, string>>
  const uri: unknown = expand(uriTemplate, captured)
  if (uri instanceof Promise) void uri.catch(() => undefined)
  assertMcpResourceUri(uri)
  return uri
}
