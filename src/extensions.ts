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

export type ExtensionCleanup = () => void | Promise<void>

/** Opt-in ownership for trusted registrations and host cleanup; grants no permissions. */
export interface ExtensionScope {
  readonly signal: AbortSignal
  readonly state: 'open' | 'closing' | 'closed'
  register(extension: ToolExtension): void
  /** Register cleanup immediately when ownership transfers. Requires an open scope. */
  defer(cleanup: ExtensionCleanup): void
  /** Fixed tools/executors. Dispatch remains bound to this scope's lifetime. */
  snapshot(): ToolRegistry
  /** Synchronously seal and abort; await reverse cleanup with one memoized completion. */
  dispose(): Promise<void>
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

function linkSignals(caller: AbortSignal, owner: AbortSignal): {
  signal: AbortSignal
  release: () => void
} {
  const controller = new AbortController()
  const listeners: { signal: AbortSignal, listener: () => void }[] = []
  const release = (): void => {
    for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener)
    listeners.length = 0
  }
  try {
    for (const signal of new Set([caller, owner])) {
      if (signal.aborted) {
        controller.abort(signal.reason)
        release()
        break
      }
      const listener = (): void => { controller.abort(signal.reason); release() }
      listeners.push({ signal, listener })
      signal.addEventListener('abort', listener, { once: true })
    }
  } catch (error) {
    release()
    throw error
  }
  return { signal: controller.signal, release }
}

/**
 * Own explicitly imported v1 tools and host-provided cleanup. Registration is atomic and
 * snapshots never acquire later tools. Closing blocks retained-snapshot dispatch and aborts
 * admitted calls, but does not await or forcibly stop arbitrary trusted executor promises.
 */
export function createExtensionScope(
  options: { readonly reservedNames?: readonly string[] } = {}
): ExtensionScope {
  // Reuse the static registry's complete options validation, then capture reservations once.
  const emptyRegistry = createToolRegistry([], options)
  const names = new Set(options.reservedNames ?? [])
  const ids = new Set<string>()
  const registrations = new Map<string, ToolRegistry>()
  const tools: ToolDefinition[] = []
  const cleanups: ExtensionCleanup[] = []
  const controller = new AbortController()
  let state: ExtensionScope['state'] = 'open'
  let disposal: Promise<void> | undefined
  const assertOpen = (): void => { assert(state === 'open', 'Extension scope is not open') }
  return Object.freeze({
    signal: controller.signal,
    get state(): ExtensionScope['state'] { return state },
    register(extension: ToolExtension): void {
      assertOpen()
      dataObject(extension, 'Extension must be a plain data object')
      const id = extension.id
      assert(identifier(id), 'Extension id must be a nonempty, trimmed string')
      assert(extension.apiVersion === 1, `Unsupported extension API version: ${id}`)
      assert(!ids.has(id), `Duplicate extension id: ${id}`)
      // Validation/capture finishes before publishing any of this candidate's tools.
      const candidate = createToolRegistry([extension], { reservedNames: [...names] })
      ids.add(id)
      for (const definition of candidate.tools) {
        names.add(definition.name)
        registrations.set(definition.name, candidate)
        tools.push(definition)
      }
    },
    defer(cleanup: ExtensionCleanup): void {
      assertOpen()
      assert(typeof cleanup === 'function', 'Extension cleanup must be a function')
      cleanups.push(cleanup)
    },
    snapshot(): ToolRegistry {
      assertOpen()
      const capturedTools = Object.freeze([...tools])
      const capturedRegistrations = new Map(registrations)
      return Object.freeze({
        tools: capturedTools,
        has(name: string): boolean { return capturedRegistrations.has(name) },
        async executeTool(call: ToolCall, context: { signal: AbortSignal }): Promise<ToolResult> {
          assert(record(context) && context.signal instanceof AbortSignal,
            'Tool context requires an AbortSignal')
          controller.signal.throwIfAborted()
          context.signal.throwIfAborted()
          const linked = linkSignals(context.signal, controller.signal)
          try {
            // Preserve static-registry validation/error behavior, including unknown tools.
            assertJson(call)
            assertCall(call)
            const registry = capturedRegistrations.get(call.name) ?? emptyRegistry
            return await registry.executeTool(call, { signal: linked.signal })
          } finally {
            linked.release()
          }
        }
      })
    },
    dispose(): Promise<void> {
      if (disposal) return disposal
      let resolve!: () => void
      let reject!: (reason: unknown) => void
      disposal = new Promise<void>((resolve_, reject_) => { resolve = resolve_; reject = reject_ })
      state = 'closing'
      // Publish the shared completion before synchronous abort listeners can reenter dispose.
      controller.abort()
      void (async () => {
        const errors: unknown[] = []
        while (cleanups.length) {
          const cleanup = cleanups.pop()!
          try { await cleanup() } catch (error) { errors.push(error) }
        }
        state = 'closed'
        if (errors.length) throw new AggregateError(errors, 'Extension scope cleanup failed')
      })().then(resolve, reject)
      return disposal
    }
  })
}
