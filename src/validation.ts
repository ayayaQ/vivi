// SPDX-License-Identifier: Apache-2.0
import type { HistoryMessage, ToolCall, ToolImageReference } from './types.js'

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

/** Shared bounds for persisted references and provider snapshot resolution. */
export const TOOL_IMAGE_LIMITS = Object.freeze({ perResult: 4, bytes: 5 * 1024 * 1024, pixels: 16_000_000 })

/** Conservative portable visual budget; not a tokenizer/provider measurement. */
export function imageInputTokenAllowance(image: ToolImageReference): number {
  return 4096 + 4096 * Math.ceil(image.width / 512) * Math.ceil(image.height / 512)
}

export function assertToolImages(value: unknown): asserts value is readonly ToolImageReference[] {
  assertJson(value)
  assert(Array.isArray(value) && value.length > 0 && value.length <= TOOL_IMAGE_LIMITS.perResult,
    'Tool images must contain 1..4 references')
  const ids = new Set<string>()
  for (const image of value) {
    assert(record(image) && Object.keys(image).length === 6 &&
      ['id', 'sha256', 'mimeType', 'width', 'height', 'byteLength'].every(key => Object.hasOwn(image, key)),
    'Tool image reference requires exact metadata fields')
    assert(identifier(image.id) && image.id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(image.id), 'Invalid tool image id')
    assert(!ids.has(image.id), 'Duplicate tool image id'); ids.add(image.id)
    assert(typeof image.sha256 === 'string' && /^[a-f0-9]{64}$/.test(image.sha256), 'Invalid tool image sha256')
    assert(image.mimeType === 'image/png' || image.mimeType === 'image/jpeg', 'Unsupported tool image MIME type')
    assert(Number.isSafeInteger(image.width) && (image.width as number) > 0 &&
      Number.isSafeInteger(image.height) && (image.height as number) > 0 &&
      (image.width as number) * (image.height as number) <= TOOL_IMAGE_LIMITS.pixels, 'Invalid tool image dimensions')
    assert(Number.isSafeInteger(image.byteLength) && (image.byteLength as number) > 0 &&
      (image.byteLength as number) <= TOOL_IMAGE_LIMITS.bytes, 'Invalid tool image byte length')
  }
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

/** Exact message fields shared by opt-in steering admission and durable history records.
 * Full JSON, value and transcript-order checks remain in assertHistory. */
export function assertCanonicalHistoryFields(message: unknown): void {
  const keys = (value: unknown, required: readonly string[], optional: readonly string[] = []): void => {
    assert(record(value), 'History fields must be JSON objects')
    assert(required.every(key => Object.hasOwn(value, key)) &&
      Object.keys(value).every(key => required.includes(key) || optional.includes(key)),
    'Invalid or unsupported history message fields')
  }
  assert(record(message), 'History message must be an object')
  if (message.kind === 'message') keys(message, ['kind', 'role', 'content'])
  else if (message.kind === 'assistant') {
    keys(message, ['kind', 'content', 'toolCalls'], ['providerState'])
    assert(Array.isArray(message.toolCalls), 'Assistant toolCalls must be an array')
    for (const call of message.toolCalls) keys(call, ['id', 'name', 'arguments'])
    if ('providerState' in message) keys(message.providerState, ['provider', 'items'])
  } else if (message.kind === 'tool_result') keys(message, ['kind', 'callId', 'name', 'content'], ['isError', 'images'])
  else throw new Error('Invalid history message kind')
}

/** Steering uses the record-compatible exact fields; published legacy validation stays permissive. */
export function assertCanonicalHistory(messages: unknown): asserts messages is HistoryMessage[] {
  assertHistory(messages)
  for (const message of messages) assertCanonicalHistoryFields(message)
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
      if ('images' in message) assertToolImages(message.images)
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

/** Stable sanitized overflow signal for adapters and hosts, without reading message/accessor text. */
export function isContextOverflow(error: unknown): boolean {
  try {
    if (!(error instanceof Error)) return false
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    return descriptor !== undefined && 'value' in descriptor && descriptor.value === 'context_overflow'
  } catch { return false }
}
