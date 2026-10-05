// SPDX-License-Identifier: Apache-2.0
import type { JsonObject, ToolCall, ToolDefinition, ToolResult } from './types.js'
import { assert, assertCall, assertJson, identifier, record } from './validation.js'

export interface ExtensionTool {
  readonly definition: ToolDefinition
  /** Synchronous assertion: throw when arguments do not match the tool's contract. */
  readonly validateArguments: (arguments_: Readonly<JsonObject>) => void
  readonly execute: (call: ToolCall, context: { readonly signal: AbortSignal }) =>
    ToolResult | Promise<ToolResult>
}

/** Trusted, explicitly imported code. This contract grants no permissions or isolation. */
export interface ToolExtension {
  readonly id: string
  readonly apiVersion: 1
  readonly tools: readonly ExtensionTool[]
}

export interface ToolRegistry {
  /** Deeply frozen copies. Pair these definitions with this registry's executeTool. */
  readonly tools: readonly ToolDefinition[]
  has(name: string): boolean
  executeTool(call: ToolCall, context: { signal: AbortSignal }): Promise<ToolResult>
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function detail(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === 'string') return error.message
  } catch { /* Use best-effort conversion below. */ }
  try { return String(error) } catch { return 'Unprintable thrown value' }
}

function failure(code: string, message: string): ToolResult {
  return { content: JSON.stringify({ success: false, error: { code, message } }), isError: true }
}

function dataObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  assert(record(value) && (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null), message)
  assert(Object.getOwnPropertySymbols(value).length === 0 &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
      descriptor.enumerable && 'value' in descriptor), message)
}

/**
 * Create a fixed executable snapshot, normally once per host turn. Registration errors throw.
 * Capture function references as well as schemas: later edits to the source extension cannot
 * replace the implementation underneath tools already advertised to a provider.
 */
export function createToolRegistry(
  extensions: readonly ToolExtension[],
  options: { readonly reservedNames?: readonly string[] } = {}
): ToolRegistry {
  assert(Array.isArray(extensions), 'Extensions must be an array')
  dataObject(options, 'Registry options must be a plain data object')
  const reservedNames = options.reservedNames === undefined ? [] : options.reservedNames
  assertJson(reservedNames)
  assert(Array.isArray(reservedNames) && reservedNames.every(identifier),
    'Reserved names must be nonempty, trimmed strings')
  const names = new Set(reservedNames)
  const ids = new Set<string>()
  const implementations = new Map<string, {
    validateArguments: ExtensionTool['validateArguments']
    execute: ExtensionTool['execute']
  }>()
  const tools: ToolDefinition[] = []
  for (const extension of extensions) {
    dataObject(extension, 'Extension must be a plain data object')
    assert(identifier(extension.id), 'Extension id must be a nonempty, trimmed string')
    assert(extension.apiVersion === 1, `Unsupported extension API version: ${extension.id}`)
    assert(!ids.has(extension.id), `Duplicate extension id: ${extension.id}`)
    ids.add(extension.id)
    assert(Array.isArray(extension.tools), `Extension tools must be an array: ${extension.id}`)
    for (const tool of extension.tools) {
      dataObject(tool, 'Extension tool must be a plain data object')
      const { definition, validateArguments, execute } = tool
      assertJson(definition)
      assert(record(definition) && identifier(definition.name),
        'Tool definition name must be a nonempty, trimmed string')
      assert(typeof definition.description === 'string', 'Tool description must be a string')
      assert(record(definition.parameters), 'Tool parameters must be a JSON object')
      assert(typeof validateArguments === 'function', 'Tool must validate arguments')
      assert(typeof execute === 'function', 'Tool must implement execute')
      assert(!names.has(definition.name), `Tool name collision: ${definition.name}`)
      names.add(definition.name)
      tools.push(structuredClone(definition) as unknown as ToolDefinition)
      implementations.set(definition.name, {
        validateArguments: validateArguments as ExtensionTool['validateArguments'],
        execute: execute as ExtensionTool['execute']
      })
    }
  }
  freeze(tools)
  return Object.freeze({
    tools,
    has(name: string): boolean { return implementations.has(name) },
    async executeTool(call: ToolCall, context: { signal: AbortSignal }): Promise<ToolResult> {
      assert(record(context) && context.signal instanceof AbortSignal, 'Tool context requires an AbortSignal')
      const signal = context.signal
      signal.throwIfAborted()
      // Malformed JS calls throw before trusted extension code runs. The runner validates too.
      assertJson(call)
      assertCall(call)
      const captured = freeze(structuredClone(call))
      const implementation = implementations.get(captured.name)
      if (!implementation) return failure('unavailable_tool', `Tool is not registered: ${captured.name}`)
      const { validateArguments, execute } = implementation
      try {
        const validation: unknown = validateArguments(captured.arguments)
        // Validators must be synchronous assertions; do not silently accept false/async results.
        if (validation !== undefined) void Promise.resolve(validation).catch(() => {})
        assert(validation === undefined, 'Argument validator must return undefined')
      } catch (error) {
        signal.throwIfAborted()
        return failure('invalid_arguments', detail(error))
      }
      signal.throwIfAborted()
      try {
        const result: unknown = await execute(captured, Object.freeze({ signal }))
        signal.throwIfAborted()
        assertJson(result)
        assert(record(result) && typeof result.content === 'string', 'Tool result content must be a string')
        if ('isError' in result) assert(typeof result.isError === 'boolean', 'Tool isError must be boolean')
        return structuredClone(result) as unknown as ToolResult
      } catch (error) {
        signal.throwIfAborted()
        return failure('tool_error', detail(error))
      }
    }
  })
}
