// SPDX-License-Identifier: Apache-2.0
import type { HistoryMessage, ToolCall } from './types.js'

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Reject values JSON cannot round-trip, including accessors and sparse arrays. */
export function assertJson(value: unknown, ancestors = new Set<object>()): void {
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

export function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

export function assertCall(value: unknown): asserts value is ToolCall {
  assert(record(value), 'Tool call must be an object')
  assert(identifier(value.id), 'Tool call id must be a nonempty, trimmed string')
  assert(identifier(value.name), 'Tool call name must be a nonempty, trimmed string')
  assert(record(value.arguments), 'Tool call arguments must be a JSON object')
}

export function assertProviderState(value: unknown): void {
  assert(record(value), 'Provider state must be an object')
  assert(identifier(value.provider), 'Provider state must identify its adapter')
  assert(Array.isArray(value.items), 'Provider state items must be an array')
}

export function assertHistory(messages: unknown, allowInterrupted = false): asserts messages is HistoryMessage[] {
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
    assert(allowInterrupted || pending.length === 0, 'History contains unanswered tool calls')
    pending = []
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
  assert(allowInterrupted || pending.length === 0, 'History contains unanswered tool calls')
}
