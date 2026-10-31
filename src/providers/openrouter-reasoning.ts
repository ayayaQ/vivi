// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import { createHash } from 'node:crypto'
import type { HistoryMessage, JsonObject, ProviderResult, ToolDefinition } from '../types.js'

type Input = { messages: readonly HistoryMessage[]; tools: readonly ToolDefinition[] }
const bindingKey = '_vivi_openrouter_reasoning'
const reasoningFields = new Set(['reasoning', 'reasoning_content', 'reasoning_details'])
const bindingFields = new Set([bindingKey])
const staleFields = new Set([...reasoningFields, bindingKey])
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function native(message: HistoryMessage, model: string): JsonObject | undefined {
  if (!model.startsWith('anthropic/') || message.kind !== 'assistant' ||
      message.providerState?.provider !== `openrouter:${model}` ||
      !Array.isArray(message.providerState.items) || message.providerState.items.length !== 1) return undefined
  const item = message.providerState.items[0]
  return object(item) && Object.keys(item).some(key => reasoningFields.has(key)) ? item : undefined
}

function without(item: JsonObject, keys: ReadonlySet<string>): JsonObject {
  return Object.fromEntries(Object.entries(item).filter(([key]) => !keys.has(key)))
}
const withoutBinding = (item: JsonObject): JsonObject => without(item, bindingFields)
const prefixHash = (tools: readonly ToolDefinition[], reasoning?: JsonObject) =>
  createHash('sha256').update(JSON.stringify({ tools, reasoning: reasoning ?? null })).update('\n')
const prefixDigest = (input: Input, reasoning?: JsonObject): string => {
  const hash = prefixHash(input.tools, reasoning)
  for (const message of input.messages) hash.update(JSON.stringify(message)).update('\n')
  return hash.digest('hex')
}

/** Claude binds thinking to the preceding conversation. Legacy/imported signatures have no
 * verifiable binding; omit them from this request view without rewriting saved history.
 * Each later block is checked against the already-projected prefix, so an earlier edit or
 * dropped block also invalidates every later binding. Image references remain immutable
 * canonical identities here: estimates need not resolve bytes to make the same decision.
 */
export function projectOpenRouterReasoning(input: Input, model: string, reasoning?: JsonObject): Input {
  if (!model.startsWith('anthropic/')) return input
  // Bind the actual detached request, not caller-owned objects that could change during
  // credential resolution, image resolution, streaming or the asynchronous HTTP request.
  input = structuredClone(input)
  const messages: HistoryMessage[] = []
  const hash = prefixHash(input.tools, reasoning)
  for (const message of input.messages) {
    const item = native(message, model)
    let projected = message
    if (message.kind === 'assistant' && item) {
      const binding = item[bindingKey]
      if (!object(binding) || binding.version !== 1 ||
          binding.assistant !== digest(withoutBinding(item)) ||
          binding.prefix !== hash.copy().digest('hex')) {
        projected = { ...message, providerState: { ...message.providerState!, items: [
          without(item, staleFields)
        ] } }
      }
    }
    messages.push(projected)
    hash.update(JSON.stringify(projected)).update('\n')
  }
  return { ...input, messages }
}

/** Private JSON metadata stays inside opaque providerState, never in API messages. No API
 * key, raw request, or host instruction is retained. This survives JSON persistence and
 * constructing another provider instance, without adding fields to canonical contracts.
 */
export function bindOpenRouterReasoning(result: ProviderResult, input: Input, model: string,
  reasoning?: JsonObject): ProviderResult {
  const item = native({ kind: 'assistant', ...result }, model)
  if (!item) return result
  const binding = { version: 1, assistant: digest(withoutBinding(item)), prefix: prefixDigest(input, reasoning) }
  return { ...result, providerState: { ...result.providerState!, items: [{ ...item, [bindingKey]: binding }] } }
}
