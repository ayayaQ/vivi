// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
// Generalized from Bot Commander Desktop's agentProviderAdapter.ts; see ATTRIBUTION.md.
import type { HistoryMessage, JsonObject, JsonValue, ProviderResult, ToolCall } from '../types.js'
import { ProviderRequestError } from './transport.js'

export type Provider = 'OpenAI' | 'OpenRouter'
export const MAX_ARGUMENT_CHARS = 1_048_576
export const MAX_ITEMS = 4_096

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

export function fail(provider: Provider, detail: string): never {
  throw new ProviderRequestError(provider, 'invalid_response', `Invalid ${provider} agent output: ${detail}`)
}

export function identifier(value: unknown, provider: Provider, label: string): string {
  if (typeof value !== 'string' || !value || /\s/.test(value)) {
    fail(provider, `${label} must be a non-empty identifier`)
  }
  return value
}

export function parseArguments(value: unknown, provider: Provider): JsonObject {
  if (typeof value !== 'string') fail(provider, 'tool arguments must be a JSON string')
  if (value.length > MAX_ARGUMENT_CHARS) fail(provider, 'tool arguments exceeded the size limit')
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    fail(provider, 'tool arguments were not valid JSON')
  }
  if (!isRecord(parsed) || !isJsonValue(parsed)) {
    fail(provider, 'tool arguments must be a JSON object')
  }
  return parsed
}

export function parseCall(id: unknown, name: unknown, args: unknown, provider: Provider): ToolCall {
  return {
    id: identifier(id, provider, 'tool call ID'),
    name: identifier(name, provider, 'tool name'),
    arguments: parseArguments(args, provider)
  }
}

/**
 * Plain chat providers sometimes reuse turn-local IDs. Give those calls unique host IDs.
 * Never rewrite native reasoning-associated IDs: opaque state may depend on the originals.
 */
export function normalizeCallIds(
  calls: ToolCall[],
  messages: readonly HistoryMessage[],
  provider: Provider,
  allowRename = false
): boolean {
  const turnIds = new Set<string>()
  for (const call of calls) {
    if (turnIds.has(call.id)) fail(provider, 'duplicate tool call ID')
    turnIds.add(call.id)
  }
  const historyIds = new Set(
    messages.flatMap((message) =>
      message.kind === 'assistant' ? message.toolCalls.map((call) => call.id) : []
    )
  )
  const usedIds = new Set([...historyIds, ...turnIds])
  let renamed = false
  for (const call of calls) {
    if (!historyIds.has(call.id)) continue
    if (!allowRename) fail(provider, 'tool call ID was reused from history')
    let suffix = 1
    let replacement = `${call.id}__vivi_${suffix}`
    while (usedIds.has(replacement)) replacement = `${call.id}__vivi_${++suffix}`
    call.id = replacement
    usedIds.add(replacement)
    renamed = true
  }
  return renamed
}

export function tokenCount(value: unknown, provider: Provider): number {
  if (value === undefined || value === null) return 0
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(provider, 'token usage must be a non-negative integer')
  }
  return value
}

export function usage(value: unknown, provider: Provider): NonNullable<ProviderResult['usage']> {
  if (value !== undefined && value !== null && !isRecord(value)) {
    fail(provider, 'token usage must be an object')
  }
  const counts = isRecord(value) ? value : {}
  const inputTokens = tokenCount(
    counts[provider === 'OpenAI' ? 'input_tokens' : 'prompt_tokens'],
    provider
  )
  const outputTokens = tokenCount(
    counts[provider === 'OpenAI' ? 'output_tokens' : 'completion_tokens'],
    provider
  )
  const details = counts[provider === 'OpenAI' ? 'input_tokens_details' : 'prompt_tokens_details']
  if (details !== undefined && details !== null && !isRecord(details)) {
    fail(provider, 'input token details must be an object')
  }
  const cacheCounts: Pick<NonNullable<ProviderResult['usage']>, 'cachedInputTokens' | 'cacheWriteInputTokens'> = {}
  if (isRecord(details)) {
    for (const [source, target] of [
      ['cached_tokens', 'cachedInputTokens'], ['cache_write_tokens', 'cacheWriteInputTokens']
    ] as const) {
      // Missing/null details are unreported, not a measured zero.
      if (details[source] !== undefined && details[source] !== null) {
        cacheCounts[target] = tokenCount(details[source], provider)
      }
    }
  }
  return {
    inputTokens,
    outputTokens,
    ...cacheCounts,
    totalTokens:
      counts.total_tokens === undefined || counts.total_tokens === null
        ? tokenCount(inputTokens + outputTokens, provider)
        : tokenCount(counts.total_tokens, provider)
  }
}

export function optionalFields(
  target: JsonObject,
  source: Record<string, unknown>,
  names: readonly string[],
  provider: Provider
) {
  for (const name of names) {
    const value = source[name]
    if (value === undefined) continue
    if (!isJsonValue(value)) fail(provider, `invalid ${name}`)
    target[name] = structuredClone(value)
  }
}

export function completedItem(source: Record<string, unknown>, provider: Provider) {
  if (source.status !== undefined && source.status !== null && source.status !== 'completed') {
    fail(provider, 'assistant item was not completed')
  }
  if (source.id !== undefined) identifier(source.id, provider, 'assistant item ID')
}

interface OpenAiOutput {
  items: JsonObject[]
  toolCalls: ToolCall[]
  content: string
}

export function parseOpenAiOutput(value: unknown): OpenAiOutput {
  if (!Array.isArray(value)) fail('OpenAI', 'output must be an array')
  if (value.length > MAX_ITEMS) fail('OpenAI', 'too many assistant items')
  const items: JsonObject[] = []
  const toolCalls: ToolCall[] = []
  const text: string[] = []
  for (const source of value) {
    if (!isRecord(source)) fail('OpenAI', 'assistant item must be an object')
    completedItem(source, 'OpenAI')
    if (source.type === 'function_call') {
      const call = parseCall(source.call_id, source.name, source.arguments, 'OpenAI')
      toolCalls.push(call)
      const item: JsonObject = {
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: source.arguments as string
      }
      optionalFields(item, source, ['id', 'status', 'namespace', 'caller'], 'OpenAI')
      items.push(item)
    } else if (source.type === 'reasoning') {
      const reasoningId = identifier(source.id, 'OpenAI', 'reasoning item ID')
      if (!Array.isArray(source.summary)) fail('OpenAI', 'reasoning summary must be an array')
      const summary = source.summary.map((part) => {
        if (!isRecord(part) || part.type !== 'summary_text' || typeof part.text !== 'string') {
          fail('OpenAI', 'invalid reasoning summary')
        }
        return { type: 'summary_text', text: part.text }
      })
      const item: JsonObject = { type: 'reasoning', id: reasoningId, summary }
      if (
        source.encrypted_content !== undefined &&
        source.encrypted_content !== null &&
        typeof source.encrypted_content !== 'string'
      ) {
        fail('OpenAI', 'invalid encrypted reasoning')
      }
      if (source.content !== undefined && source.content !== null) {
        if (!Array.isArray(source.content)) fail('OpenAI', 'invalid reasoning content')
        item.content = source.content.map((part) => {
          if (!isRecord(part) || part.type !== 'reasoning_text' || typeof part.text !== 'string') {
            fail('OpenAI', 'invalid reasoning content')
          }
          return { type: 'reasoning_text', text: part.text }
        })
      }
      optionalFields(item, source, ['encrypted_content', 'status'], 'OpenAI')
      items.push(item)
    } else if (source.type === 'message') {
      if (source.role !== 'assistant' || !Array.isArray(source.content)) {
        fail('OpenAI', 'invalid assistant message')
      }
      const messageId = identifier(source.id, 'OpenAI', 'assistant message ID')
      const content: JsonObject[] = source.content.map((part) => {
        if (!isRecord(part)) fail('OpenAI', 'invalid assistant content')
        if (part.type === 'output_text' && typeof part.text === 'string') {
          text.push(part.text)
          const output: JsonObject = { type: 'output_text', text: part.text, annotations: [] }
          optionalFields(output, part, ['annotations', 'logprobs'], 'OpenAI')
          return output
        }
        if (part.type === 'refusal' && typeof part.refusal === 'string') {
          text.push(part.refusal)
          return { type: 'refusal', refusal: part.refusal }
        }
        fail('OpenAI', 'unsupported assistant content')
      })
      const item: JsonObject = { type: 'message', id: messageId, role: 'assistant', content }
      optionalFields(item, source, ['status', 'phase'], 'OpenAI')
      items.push(item)
    } else {
      fail('OpenAI', 'unsupported assistant item type')
    }
  }
  return { items, toolCalls, content: text.join('') }
}

/** Strict documented native reasoning blocks, with only protocol fields retained. */
export function parseReasoningDetail(value: unknown, partial = false): JsonObject {
  if (!isRecord(value) || !isJsonValue(value)) fail('OpenRouter', 'invalid reasoning detail')
  const field = value.type === 'reasoning.text' ? 'text'
    : value.type === 'reasoning.summary' ? 'summary'
      : value.type === 'reasoning.encrypted' ? 'data' : undefined
  // OpenRouter's reasoning.text blocks can be signature-only or explicitly null.
  // Summary/encrypted completed blocks still require their string payloads.
  if (!field || (!partial && field !== 'text' && typeof value[field] !== 'string')) {
    fail('OpenRouter', 'invalid reasoning detail payload')
  }
  for (const name of ['text', 'summary', 'data', 'signature']) {
    if (value[name] !== undefined && value[name] !== null && typeof value[name] !== 'string') {
      fail('OpenRouter', 'invalid reasoning detail string')
    }
  }
  if (value.id !== undefined && value.id !== null && typeof value.id !== 'string') {
    fail('OpenRouter', 'invalid reasoning detail ID')
  }
  if (value.format !== undefined && value.format !== null && typeof value.format !== 'string') {
    fail('OpenRouter', 'invalid reasoning detail format')
  }
  if (value.index !== undefined && (!Number.isSafeInteger(value.index) ||
      (value.index as number) < 0 || (value.index as number) >= MAX_ITEMS)) {
    fail('OpenRouter', 'invalid reasoning detail index')
  }
  const item: JsonObject = { type: value.type as string }
  optionalFields(item, value, ['id', 'format', 'index', field, 'signature'], 'OpenRouter')
  return item
}

interface OpenRouterOutput {
  item: JsonObject
  toolCalls: ToolCall[]
  content: string
}

export function parseOpenRouterMessage(value: unknown): OpenRouterOutput {
  if (!isRecord(value)) fail('OpenRouter', 'assistant message must be an object')
  if (value.role !== undefined && value.role !== 'assistant') {
    fail('OpenRouter', 'invalid assistant role')
  }
  let nativeContent: JsonValue = value.content === null ? null : ''
  let content = ''
  if (typeof value.content === 'string') {
    nativeContent = content = value.content
  } else if (Array.isArray(value.content)) {
    const text: string[] = []
    nativeContent = value.content.map((part) => {
      if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') {
        fail('OpenRouter', 'unsupported or invalid assistant content part')
      }
      text.push(part.text)
      const item: JsonObject = { type: 'text', text: part.text }
      optionalFields(item, part, ['cache_control', 'prompt_cache_breakpoint'], 'OpenRouter')
      return item
    })
    content = text.join('')
  } else if (value.content !== undefined && value.content !== null) {
    fail('OpenRouter', 'assistant content must be text or text parts')
  }
  const rawCalls = value.tool_calls ?? []
  if (!Array.isArray(rawCalls)) fail('OpenRouter', 'tool calls must be an array')
  if (rawCalls.length > MAX_ITEMS) fail('OpenRouter', 'too many tool calls')
  const nativeCalls: JsonObject[] = []
  const toolCalls = rawCalls.map((call) => {
    if (!isRecord(call) || call.type !== 'function' || !isRecord(call.function)) {
      fail('OpenRouter', 'invalid export function call')
    }
    // OpenRouter's completed-response schema permits omitted arguments for empty calls.
    const argumentsJson = call.function.arguments === undefined ? '{}' : call.function.arguments
    const parsed = parseCall(call.id, call.function.name, argumentsJson, 'OpenRouter')
    nativeCalls.push({
      id: parsed.id,
      type: 'function',
      function: { name: parsed.name, arguments: argumentsJson as string }
    })
    return parsed
  })
  const item: JsonObject = {
    role: 'assistant',
    content: nativeContent,
    ...(toolCalls.length ? { tool_calls: nativeCalls } : {})
  }
  for (const name of ['reasoning', 'reasoning_content']) {
    if (value[name] !== undefined && value[name] !== null && typeof value[name] !== 'string') {
      fail('OpenRouter', `invalid ${name}`)
    }
  }
  if (
    value.reasoning_details !== undefined &&
    value.reasoning_details !== null &&
    !Array.isArray(value.reasoning_details)
  ) {
    fail('OpenRouter', 'invalid reasoning_details')
  }
  if (Array.isArray(value.reasoning_details)) {
    if (value.reasoning_details.length > MAX_ITEMS) fail('OpenRouter', 'too many reasoning details')
    item.reasoning_details = value.reasoning_details.map((detail) => parseReasoningDetail(detail))
  }
  if (value.refusal !== undefined && value.refusal !== null && typeof value.refusal !== 'string') {
    fail('OpenRouter', 'invalid refusal')
  }
  if (typeof value.refusal === 'string') content += value.refusal
  optionalFields(item, value, ['reasoning', 'reasoning_content', 'refusal'], 'OpenRouter')
  if (value.reasoning_details === null) item.reasoning_details = null
  return { item, toolCalls, content }
}

export function toChatToolCalls(calls: readonly ToolCall[]): JsonObject[] {
  return calls.map((call) => ({
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments) }
  }))
}

export function sameCalls(left: readonly ToolCall[], right: readonly ToolCall[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (call, index) =>
        call.id === right[index]!.id &&
        call.name === right[index]!.name &&
        JSON.stringify(call.arguments) === JSON.stringify(right[index]!.arguments)
    )
  )
}

export function nativeOpenAiItems(
  message: Extract<HistoryMessage, { kind: 'assistant' }>,
  model: string
): OpenAiOutput | undefined {
  if (message.providerState?.provider !== `openai:${model}`) return undefined
  try {
    const native = parseOpenAiOutput(message.providerState.items)
    return native.items.length && sameCalls(native.toolCalls, message.toolCalls) &&
      (!native.items.some((item) => item.type === 'message') || native.content === message.content)
      ? native
      : undefined
  } catch {
    // Persisted native state is optional. Canonical history remains usable if it is obsolete.
    return undefined
  }
}

export function nativeOpenRouterItem(
  message: Extract<HistoryMessage, { kind: 'assistant' }>,
  model: string
): JsonObject | undefined {
  if (
    message.providerState?.provider !== `openrouter:${model}` ||
    !Array.isArray(message.providerState.items) ||
    message.providerState.items.length !== 1
  ) {
    return undefined
  }
  try {
    const native = parseOpenRouterMessage(message.providerState.items[0])
    return sameCalls(native.toolCalls, message.toolCalls) && native.content === message.content
      ? native.item : undefined
  } catch {
    return undefined
  }
}

/** Native reasoning is only compatible with the exact provider and model that produced it. */
export function projectOpenAiHistory(
  messages: readonly HistoryMessage[],
  model: string
): JsonObject[] {
  const input: JsonObject[] = []
  const pendingCalls = new Map<string, string>()
  for (const message of messages) {
    if (message.kind === 'message') {
      input.push({ role: message.role, content: message.content })
    } else if (message.kind === 'assistant') {
      const native = nativeOpenAiItems(message, model)
      if (native) {
        input.push(...native.items)
        if (message.content && !native.items.some((item) => item.type === 'message')) {
          input.push({ role: 'assistant', content: message.content })
        }
      } else {
        if (message.content) input.push({ role: 'assistant', content: message.content })
        input.push(
          ...message.toolCalls.map((call) => ({
            type: 'function_call',
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.arguments)
          }))
        )
      }
      for (const call of message.toolCalls) pendingCalls.set(call.id, call.name)
    } else {
      if (pendingCalls.get(message.callId) !== message.name) {
        throw new ProviderRequestError('OpenAI', 'configuration', 'Agent history contains an unmatched tool result')
      }
      input.push({ type: 'function_call_output', call_id: message.callId, output: message.content })
      pendingCalls.delete(message.callId)
    }
  }
  return input
}

export function projectOpenRouterHistory(
  messages: readonly HistoryMessage[],
  model: string
): JsonObject[] {
  const input: JsonObject[] = []
  const pendingCalls = new Map<string, string>()
  for (const message of messages) {
    if (message.kind === 'message') {
      input.push({ role: message.role, content: message.content })
    } else if (message.kind === 'assistant') {
      input.push(
        nativeOpenRouterItem(message, model) || {
          role: 'assistant',
          content: message.content || null,
          ...(message.toolCalls.length ? { tool_calls: toChatToolCalls(message.toolCalls) } : {})
        }
      )
      for (const call of message.toolCalls) pendingCalls.set(call.id, call.name)
    } else {
      if (pendingCalls.get(message.callId) !== message.name) {
        throw new ProviderRequestError('OpenRouter', 'configuration', 'Agent history contains an unmatched tool result')
      }
      input.push({ role: 'tool', tool_call_id: message.callId, content: message.content })
      pendingCalls.delete(message.callId)
    }
  }
  return input
}

