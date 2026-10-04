// SPDX-License-Identifier: Apache-2.0
import type {
  AgentError,
  AgentEvent,
  AgentResult,
  AssistantMessage,
  HistoryMessage,
  ProviderResult,
  RunAgentOptions,
  ToolCall,
  ToolDefinition,
  ToolResult,
  ToolResultMessage,
  Usage
} from './types.js'

class RunFailure extends Error {
  constructor(readonly code: AgentError['code'], message: string) {
    super(message)
  }
}

class Cancelled extends Error {}

function detail(error: unknown): string {
  // Thrown values can have no prototype or hostile coercion/message accessors. Formatting
  // must not replace the original provider/tool/hook failure with a second exception.
  try {
    if (error instanceof Error) {
      const message: unknown = error.message
      if (typeof message === 'string') return message
    }
  } catch {
    // Fall through to best-effort string conversion.
  }
  try {
    return String(error)
  } catch {
    return 'Unprintable thrown value'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Reject values JSON cannot round-trip, including accessors and sparse arrays. */
function assertJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    assert(Number.isFinite(value), 'JSON numbers must be finite')
    return
  }
  assert(typeof value === 'object' && value !== null, 'Expected JSON data')
  assert(!ancestors.has(value), 'JSON data must not contain cycles')
  assert(
    Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null,
    'JSON objects must be plain objects'
  )
  ancestors.add(value)
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    assert(Object.getOwnPropertySymbols(value).length === 0, 'JSON data must not contain symbols')
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        assert(Object.hasOwn(descriptors, String(index)), 'JSON arrays must not be sparse')
      }
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue
      assert(descriptor.enumerable && 'value' in descriptor, 'JSON data must use enumerable values')
      if (Array.isArray(value)) {
        assert(/^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length, 'Invalid JSON array property')
      }
      assertJson(descriptor.value, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function assertCall(value: unknown): asserts value is ToolCall {
  assert(record(value), 'Tool call must be an object')
  assert(identifier(value.id), 'Tool call id must be a nonempty, trimmed string')
  assert(identifier(value.name), 'Tool call name must be a nonempty, trimmed string')
  assert(record(value.arguments), 'Tool call arguments must be a JSON object')
}

function assertProviderState(value: unknown): void {
  assert(record(value), 'Provider state must be an object')
  assert(identifier(value.provider), 'Provider state must identify its adapter')
  assert(Array.isArray(value.items), 'Provider state items must be an array')
}

function assertUsage(value: unknown): asserts value is Usage {
  assert(record(value), 'Usage must be an object')
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) {
    const count = value[key]
    assert(typeof count === 'number' && Number.isSafeInteger(count) && count >= 0,
      `Usage ${key} must be a nonnegative safe integer`)
  }
}

function assertProviderResult(value: unknown, seenIds: ReadonlySet<string>): asserts value is ProviderResult {
  assertJson(value)
  assert(record(value), 'Provider result must be an object')
  assert(typeof value.content === 'string', 'Provider content must be a string')
  assert(Array.isArray(value.toolCalls), 'Provider toolCalls must be an array')
  const turnIds = new Set<string>()
  for (const call of value.toolCalls) {
    assertCall(call)
    assert(!seenIds.has(call.id) && !turnIds.has(call.id), `Duplicate tool call id: ${call.id}`)
    turnIds.add(call.id)
  }
  if ('usage' in value) assertUsage(value.usage)
  if ('providerState' in value) assertProviderState(value.providerState)
}

function assertToolResult(value: unknown): asserts value is ToolResult {
  assertJson(value)
  assert(record(value), 'Tool result must be an object')
  assert(typeof value.content === 'string', 'Tool result content must be a string')
  if ('isError' in value) assert(typeof value.isError === 'boolean', 'Tool isError must be boolean')
}

function assertHistory(messages: unknown): asserts messages is HistoryMessage[] {
  assertJson(messages)
  assert(Array.isArray(messages), 'Messages must be an array')
  const seenIds = new Set<string>()
  let pending: ToolCall[] = []
  for (const message of messages) {
    assert(record(message), 'History message must be an object')
    assert(typeof message.content === 'string', 'History content must be a string')
    if (message.kind === 'tool_result') {
      const expected = pending.shift()
      assert(expected, 'Tool result has no pending call')
      assert(message.callId === expected.id && message.name === expected.name,
        'Tool result must match the next pending call id and name')
      if ('isError' in message) assert(typeof message.isError === 'boolean', 'Tool isError must be boolean')
      continue
    }
    assert(pending.length === 0, 'History contains unanswered tool calls')
    if (message.kind === 'message') {
      assert(message.role === 'user' || message.role === 'system', 'Invalid message role')
    } else if (message.kind === 'assistant') {
      assert(Array.isArray(message.toolCalls), 'Assistant toolCalls must be an array')
      for (const call of message.toolCalls) {
        assertCall(call)
        assert(!seenIds.has(call.id), `Duplicate tool call id: ${call.id}`)
        seenIds.add(call.id)
      }
      if ('providerState' in message) assertProviderState(message.providerState)
      pending = message.toolCalls.slice()
    } else {
      throw new Error('Invalid history message kind')
    }
  }
  assert(pending.length === 0, 'History contains unanswered tool calls')
}

function assertTools(tools: unknown): asserts tools is ToolDefinition[] {
  assertJson(tools)
  assert(Array.isArray(tools), 'Tools must be an array')
  const names = new Set<string>()
  for (const tool of tools) {
    assert(record(tool), 'Tool definition must be an object')
    assert(identifier(tool.name), 'Tool definition name must be a nonempty, trimmed string')
    assert(typeof tool.description === 'string', 'Tool description must be a string')
    assert(record(tool.parameters), 'Tool parameters must be a JSON object')
    assert(!names.has(tool.name), `Duplicate tool definition: ${tool.name}`)
    names.add(tool.name)
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function snapshot<T>(value: T): T {
  return freeze(structuredClone(value))
}

/** Race uncooperative host waits with abort; late settlements are observed but ignored. */
function wait<T>(operation: () => T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      callback()
    }
    const abort = (): void => finish(() => reject(new Cancelled()))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    try {
      Promise.resolve(operation()).then(
        (value) => signal.aborted ? abort() : finish(() => resolve(value)),
        (error: unknown) => signal.aborted ? abort() : finish(() => reject(error))
      )
    } catch (error) {
      if (signal.aborted) abort()
      else finish(() => reject(error))
    }
  })
}

function failureResult(call: ToolCall, code: string, message: string): ToolResultMessage {
  return {
    kind: 'tool_result',
    callId: call.id,
    name: call.name,
    content: JSON.stringify({ success: false, error: { code, message } }),
    isError: true
  }
}

/** Run one bounded conversation turn. Domain policy, approval and persistence belong to the host. */
export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  let history: HistoryMessage[] = []
  let content = ''
  let rounds = 0
  const usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let pending: ToolCall[] = []
  let signal: AbortSignal = new AbortController().signal

  const result = (status: AgentResult['status'], error?: AgentError): AgentResult => ({
    status, history, content, rounds, usage, ...(error ? { error } : {})
  })

  try {
    try {
      assert(record(options), 'Options must be an object')
      assertHistory(options.messages)
      history = structuredClone(options.messages)
      assertTools(options.tools)
      assert(options.provider && typeof options.provider.generate === 'function', 'Provider must implement generate')
      assert(typeof options.executeTool === 'function', 'executeTool must be a function')
      assert(options.onEvent === undefined || typeof options.onEvent === 'function', 'onEvent must be a function')
      assert(options.signal === undefined || options.signal instanceof AbortSignal, 'signal must be an AbortSignal')
      const limit = options.maxRounds === undefined ? 25 : options.maxRounds
      assert(Number.isInteger(limit) && limit >= 1 && limit <= 1000, 'maxRounds must be an integer from 1 to 1000')
    } catch (error) {
      throw new RunFailure('invalid_input', detail(error))
    }

    signal = options.signal ?? signal
    const maxRounds = options.maxRounds ?? 25
    const tools = structuredClone(options.tools)
    const advertised = new Set(tools.map((tool) => tool.name))
    const seenIds = new Set(history.flatMap((message) => message.kind === 'assistant'
      ? message.toolCalls.map((call) => call.id) : []))
    const generate = options.provider.generate.bind(options.provider)
    const executeTool = options.executeTool
    const onEvent = options.onEvent

    const checkAbort = (): void => { if (signal.aborted) throw new Cancelled() }
    const emit = async (event: AgentEvent): Promise<void> => {
      checkAbort()
      if (!onEvent) return
      try {
        await wait(() => onEvent(snapshot(event)), signal)
        checkAbort()
      } catch (error) {
        if (signal.aborted || error instanceof Cancelled) throw new Cancelled()
        throw new RunFailure('event_error', detail(error))
      }
    }

    for (let round = 0; round < maxRounds; round++) {
      checkAbort()
      let turn: ProviderResult
      try {
        const output: unknown = await wait(() => generate(snapshot({ messages: history, tools }), signal), signal)
        checkAbort()
        try {
          assertProviderResult(output, seenIds)
          // Check aggregate counts before committing a provider turn.
          if (output.usage) {
            for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
              assert(Number.isSafeInteger(usage[key] + output.usage[key]), 'Aggregate usage exceeds safe integer range')
            }
          }
          turn = structuredClone(output)
        } catch (error) {
          throw new RunFailure('invalid_provider_output', detail(error))
        }
      } catch (error) {
        if (signal.aborted || error instanceof Cancelled) throw new Cancelled()
        if (error instanceof RunFailure) throw error
        throw new RunFailure('provider_error', detail(error))
      }

      checkAbort()
      const assistant: AssistantMessage = {
        kind: 'assistant',
        content: turn.content,
        toolCalls: turn.toolCalls,
        ...(turn.providerState ? { providerState: turn.providerState } : {})
      }
      history.push(assistant)
      content = assistant.content
      rounds++
      if (turn.usage) {
        usage.inputTokens += turn.usage.inputTokens
        usage.outputTokens += turn.usage.outputTokens
        usage.totalTokens += turn.usage.totalTokens
      }
      pending = assistant.toolCalls.slice()
      for (const call of pending) seenIds.add(call.id)
      await emit({ type: 'assistant', message: assistant })

      while (pending.length > 0) {
        checkAbort()
        const call = pending[0]!
        await emit({ type: 'tool_started', call })
        checkAbort()
        let message: ToolResultMessage
        if (!advertised.has(call.name)) {
          message = failureResult(call, 'unavailable_tool', `Tool is not advertised: ${call.name}`)
        } else {
          try {
            const output: unknown = await wait(() => executeTool(snapshot(call), { signal }), signal)
            checkAbort()
            assertToolResult(output)
            message = {
              kind: 'tool_result', callId: call.id, name: call.name,
              content: output.content,
              ...('isError' in output ? { isError: output.isError } : {})
            }
          } catch (error) {
            if (signal.aborted || error instanceof Cancelled) throw new Cancelled()
            message = failureResult(call, 'tool_error', detail(error))
          }
        }
        checkAbort()
        history.push(message)
        pending.shift()
        await emit({ type: 'tool_completed', message })
      }

      await emit({ type: 'round_completed', ...(turn.usage ? { usage: turn.usage } : {}) })
      checkAbort()
      if (assistant.toolCalls.length === 0) return result('completed')
    }
    throw new RunFailure('max_rounds', `Agent exceeded the ${maxRounds}-round limit`)
  } catch (error) {
    const cancelled = signal.aborted || error instanceof Cancelled
    // Close calls that were accepted but not completed. Do not invoke callbacks during cleanup:
    // after abort or a hook failure, hosts must reconcile against this complete returned transcript.
    for (const call of pending) {
      history.push(failureResult(call, cancelled ? 'cancelled' : 'run_failed',
        cancelled ? 'Run cancelled before this tool completed' : 'Run ended before this tool completed'))
    }
    if (cancelled) return result('cancelled')
    const failure = error instanceof RunFailure ? error : new RunFailure('invalid_input', detail(error))
    return result('error', { code: failure.code, message: failure.message })
  }
}
