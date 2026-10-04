// SPDX-License-Identifier: Apache-2.0
import type { HistoryMessage, ToolCall } from './types.js'
import { assertHistory } from './validation.js'

/** Validate canonical history without invoking a provider or executing tools. */
export function validateHistory(messages: unknown): asserts messages is HistoryMessage[] {
  assertHistory(messages)
}

/**
 * Close incomplete persisted tool groups without replaying any operation. A historical
 * mutation may already have succeeded, so its outcome is explicitly unknown.
 */
export function closeInterruptedHistory(messages: readonly HistoryMessage[]): HistoryMessage[] {
  assertHistory(messages, true)
  const output: HistoryMessage[] = []
  let pending: ToolCall[] = []
  const closePending = (): void => {
    for (const call of pending) {
      output.push({
        kind: 'tool_result',
        callId: call.id,
        name: call.name,
        content: JSON.stringify({
          success: false,
          error: {
            code: 'interrupted',
            message: 'Tool call interrupted; the outcome may be unknown. Read current state before retrying.'
          }
        }),
        isError: true
      })
    }
    pending = []
  }
  for (const message of structuredClone(messages)) {
    if (message.kind !== 'tool_result') closePending()
    output.push(message)
    if (message.kind === 'assistant') pending = message.toolCalls.slice()
    if (message.kind === 'tool_result') pending.shift()
  }
  closePending()
  validateHistory(output)
  return output
}
