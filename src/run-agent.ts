// SPDX-License-Identifier: Apache-2.0
import type {
  AgentError,
  AgentEvent,
  AgentResult,
  AssistantMessage,
  HistoryMessage,
  ProviderResult,
  ProviderProgress,
  RunAgentOptions,
  ToolCall,
  ToolDefinition,
  ToolResult,
  ToolResultMessage,
  Usage
} from './types.js'
import { assert, assertCall, assertHistory, assertJson, assertProviderState, identifier, record } from './validation.js'

class RunFailure extends Error {
  constructor(readonly code: AgentError['code'], message: string) {
    super(message)
  }
}

class Cancelled extends Error {}

const cacheUsageKeys = ['cachedInputTokens', 'cacheWriteInputTokens'] as const

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

function assertUsage(value: unknown): asserts value is Usage {
  assert(record(value), 'Usage must be an object')
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens',
    ...cacheUsageKeys.filter((key) => key in value)]) {
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
    const emit = async (event: AgentEvent, waitSignal = signal): Promise<void> => {
      checkAbort()
      if (!onEvent) return
      try {
        await wait(() => onEvent(snapshot(event)), waitSignal)
        checkAbort()
      } catch (error) {
        if (signal.aborted || error instanceof Cancelled) throw new Cancelled()
        throw new RunFailure('event_error', detail(error))
      }
    }

    for (let round = 0; round < maxRounds; round++) {
      checkAbort()
      let turn: ProviderResult
      const roundController = new AbortController()
      const abortRound = (): void => roundController.abort()
      signal.addEventListener('abort', abortRound, { once: true })
      let acceptingProgress = true
      let roundLive = true
      let progressTail: Promise<void> = Promise.resolve()
      let progressError: unknown
      let rejectProgress!: (error: unknown) => void
      const progressFailure = new Promise<never>((_resolve, reject) => { rejectProgress = reject })
      // Observe the rejection even if a provider fails before it joins the race.
      void progressFailure.catch(() => {})
      const onProgress = (event: ProviderProgress): Promise<void> => {
        // Ignore callbacks from an obsolete generation, including uncooperative providers.
        if (!acceptingProgress || !roundLive || signal.aborted) return Promise.resolve()
        let captured: ProviderProgress
        try {
          assertJson(event)
          assert(record(event) && event.type === 'text_delta' && typeof event.text === 'string',
            'Provider progress must be a text_delta with string text')
          captured = snapshot({ type: 'text_delta', text: event.text })
        } catch (error) {
          const failure = new RunFailure('invalid_provider_output', detail(error))
          progressError = failure
          acceptingProgress = roundLive = false
          roundController.abort()
          rejectProgress(failure)
          const rejected = Promise.reject<void>(failure)
          void rejected.catch(() => {})
          return rejected
        }
        const operation = progressTail.then(async () => {
          if (!roundLive || signal.aborted) return
          await emit(captured, roundController.signal)
        })
        progressTail = operation.catch((error: unknown) => {
          // Round cleanup cancels detached progress waits; it must not replace its outcome.
          if (!roundLive) return
          progressError = error
          acceptingProgress = roundLive = false
          roundController.abort()
          rejectProgress(error)
        })
        return operation
      }
      try {
        const output: unknown = await wait(() => Promise.race([
          generate(snapshot({ messages: history, tools }), roundController.signal, Object.freeze({ onProgress })),
          progressFailure
        ]), signal)
        acceptingProgress = false
        await wait(() => progressTail, signal)
        if (progressError !== undefined) throw progressError
        checkAbort()
        try {
          assertProviderResult(output, seenIds)
          // Check aggregate counts before committing a provider turn.
          if (output.usage) {
            for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
              assert(Number.isSafeInteger(usage[key] + output.usage[key]), 'Aggregate usage exceeds safe integer range')
            }
            for (const key of cacheUsageKeys) {
              const count = output.usage[key]
              if (count !== undefined && (rounds === 0 || usage[key] !== undefined)) {
                assert(Number.isSafeInteger((usage[key] ?? 0) + count), 'Aggregate usage exceeds safe integer range')
              }
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
      } finally {
        acceptingProgress = roundLive = false
        signal.removeEventListener('abort', abortRound)
        roundController.abort()
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
      for (const key of cacheUsageKeys) {
        const count = turn.usage?.[key]
        // Once a committed round omits a field, the complete aggregate is unknown.
        if (count !== undefined && (rounds === 1 || usage[key] !== undefined)) {
          usage[key] = (usage[key] ?? 0) + count
        } else {
          delete usage[key]
        }
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
