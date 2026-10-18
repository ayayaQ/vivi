// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import type { HistoryMessage, JsonObject, ModelProvider, ProviderGenerateOptions, ProviderResult, ToolCall, ToolDefinition } from '../types.js'
import { assertHistory } from '../validation.js'
import { fail, identifier, isRecord, MAX_ARGUMENT_CHARS, MAX_ITEMS, normalizeCallIds, parseCall, sameCalls, tokenCount, usage } from './shared.js'
import { configure, estimateRequestContext, eventJson, outputTokenLimit, post, ProviderRequestError, readJson, readSse, request, reservedToolCallIds, throwIfContextOverflow } from './transport.js'
import type { Config, ProviderOptions } from './transport.js'

export { ProviderRequestError, isContextOverflow } from './transport.js'
export type { ReasoningEffort, EnabledReasoningEffort, ReasoningSelection } from './transport.js'
export interface DeepSeekProviderOptions extends ProviderOptions {}
export interface DeepSeekHistoryOptions {
  /** Whether the effective request advertises tools. Default false. */
  tools?: boolean
  /** Whether thinking is enabled (including the server default). Default true. */
  thinking?: boolean
}

interface AssistantOutput { item: JsonObject; content: string; toolCalls: ToolCall[] }

/** Only documented Chat Completions assistant fields belong in replay state. */
function assistant(value: unknown): AssistantOutput {
  if (!isRecord(value) || value.role !== 'assistant' ||
      (typeof value.content !== 'string' && value.content !== null)) {
    fail('DeepSeek', 'invalid assistant message')
  }
  const item: JsonObject = { role: 'assistant', content: value.content }
  if (value.reasoning_content !== undefined) {
    if (value.reasoning_content !== null && typeof value.reasoning_content !== 'string') {
      fail('DeepSeek', 'invalid reasoning_content')
    }
    item.reasoning_content = value.reasoning_content
  }
  const calls = value.tool_calls ?? []
  if (!Array.isArray(calls) || calls.length > MAX_ITEMS) fail('DeepSeek', 'invalid tool calls')
  const nativeCalls: JsonObject[] = []
  const toolCalls = calls.map((call) => {
    if (!isRecord(call) || call.type !== 'function' || !isRecord(call.function)) {
      fail('DeepSeek', 'invalid function call')
    }
    const parsed = parseCall(call.id, call.function.name, call.function.arguments, 'DeepSeek')
    nativeCalls.push({ id: parsed.id, type: 'function', function: {
      name: parsed.name, arguments: call.function.arguments as string
    } })
    return parsed
  })
  if (nativeCalls.length) item.tool_calls = nativeCalls
  return { item, content: value.content ?? '', toolCalls }
}

/** Exact-provider/model native state is required to remain consistent with canonical text/calls. */
function native(message: Extract<HistoryMessage, { kind: 'assistant' }>, model: string): JsonObject | undefined {
  if (message.providerState?.provider !== `deepseek:${model}`) return undefined
  try {
    if (message.providerState.items.length !== 1) throw new Error()
    const parsed = assistant(message.providerState.items[0])
    if (parsed.content !== message.content || !sameCalls(parsed.toolCalls, message.toolCalls)) throw new Error()
    return parsed.item
  } catch {
    // Silently dropping known DeepSeek reasoning would break a later tool continuation.
    throw new ProviderRequestError('DeepSeek', 'configuration', 'DeepSeek native history is inconsistent with canonical history')
  }
}

/** Foreign native state is never replayed. No reasoning is fabricated for portable history.
 * With no tools the API ignores prior reasoning, so callers can omit it from the wire/estimate.
 */
export function projectDeepSeekHistory(messages: readonly HistoryMessage[], model: string, options: DeepSeekHistoryOptions = {}): JsonObject[] {
  if (!isRecord(options) || (options.tools !== undefined && typeof options.tools !== 'boolean') ||
      (options.thinking !== undefined && typeof options.thinking !== 'boolean')) {
    throw new ProviderRequestError('DeepSeek', 'configuration', 'DeepSeek history options must use boolean tools and thinking settings')
  }
  try { assertHistory(messages) } catch {
    throw new ProviderRequestError('DeepSeek', 'configuration', 'DeepSeek requires complete, exactly paired agent history')
  }
  return messages.map((message) => {
    if (message.kind === 'message') return { role: message.role, content: message.content }
    if (message.kind === 'tool_result') return { role: 'tool', tool_call_id: message.callId, content: message.content }
    const retained = native(message, model)
    if (!retained && message.toolCalls.length) {
      throw new ProviderRequestError('DeepSeek', 'configuration', 'DeepSeek cannot replay imported tool calls; start a new session or use a portable summary')
    }
    if (options.tools && options.thinking !== false && typeof retained?.reasoning_content !== 'string') {
      throw new ProviderRequestError('DeepSeek', 'configuration', 'DeepSeek thinking with tools requires native reasoning for every assistant turn; start a new session or use a portable summary')
    }
    const item = retained ?? { role: 'assistant', content: message.content || null }
    if (!options.tools) delete item.reasoning_content
    return item
  })
}

/** Cache misses are ordinary input, never cache writes. Reasoning is already output usage. */
function tokenUsage(value: unknown): ProviderResult['usage'] {
  const normalized = usage(value, 'DeepSeek')
  if (!isRecord(value)) return normalized
  const hit = value.prompt_cache_hit_tokens
  const miss = value.prompt_cache_miss_tokens
  const details = value.prompt_tokens_details
  const detailHit = isRecord(details) ? details.cached_tokens : undefined
  const outputDetails = value.completion_tokens_details
  if (outputDetails !== undefined && outputDetails !== null && !isRecord(outputDetails)) {
    fail('DeepSeek', 'invalid completion token details')
  }
  for (const count of [hit, miss, isRecord(outputDetails) ? outputDetails.reasoning_tokens : undefined]) {
    tokenCount(count, 'DeepSeek')
  }
  if (hit !== undefined && hit !== null && detailHit !== undefined && detailHit !== null && hit !== detailHit) {
    fail('DeepSeek', 'conflicting cached token usage')
  }
  if (normalized) {
    const cached = hit ?? detailHit
    if (cached !== undefined && cached !== null) {
      if ((cached as number) > normalized.inputTokens) fail('DeepSeek', 'cached usage exceeded input tokens')
      normalized.cachedInputTokens = cached as number
    }
    if (miss !== undefined && miss !== null && ((miss as number) > normalized.inputTokens ||
        cached !== undefined && cached !== null && (cached as number) + (miss as number) !== normalized.inputTokens)) {
      fail('DeepSeek', 'invalid uncached input usage')
    }
    if (isRecord(outputDetails) && outputDetails.reasoning_tokens !== undefined &&
        tokenCount(outputDetails.reasoning_tokens, 'DeepSeek') > normalized.outputTokens) {
      fail('DeepSeek', 'reasoning usage exceeded output tokens')
    }
    // DeepSeek does not report cache writes through the generic field.
    delete normalized.cacheWriteInputTokens
  }
  return normalized
}

function result(value: unknown, model: string, messages: readonly HistoryMessage[], reservedIds: readonly string[], allowTools: boolean, requireReasoning: boolean): ProviderResult {
  throwIfContextOverflow(value, 'DeepSeek')
  if (!isRecord(value) || value.error || !Array.isArray(value.choices) ||
      value.choices.length !== 1 || !isRecord(value.choices[0])) fail('DeepSeek', 'response contained no single agent message')
  const choice = value.choices[0]
  throwIfContextOverflow(choice, 'DeepSeek')
  if (choice.error || (choice.index !== undefined && choice.index !== 0) ||
      (choice.finish_reason !== 'stop' && choice.finish_reason !== 'tool_calls')) {
    fail('DeepSeek', 'agent response was not completed')
  }
  const parsed = assistant(choice.message)
  if (requireReasoning && parsed.toolCalls.length && typeof parsed.item.reasoning_content !== 'string') {
    fail('DeepSeek', 'thinking with tools returned no native reasoning for continuation')
  }
  if ((choice.finish_reason === 'tool_calls') !== (parsed.toolCalls.length > 0) || !allowTools && parsed.toolCalls.length) {
    fail('DeepSeek', 'tool calls did not match request or completion')
  }
  // Never rewrite an identity that may be associated with native reasoning.
  normalizeCallIds(parsed.toolCalls, messages, 'DeepSeek', false, reservedIds)
  const counts = tokenUsage(value.usage)
  return { content: parsed.content, toolCalls: parsed.toolCalls,
    ...(counts !== undefined ? { usage: counts } : {}),
    providerState: { provider: `deepseek:${model}`, items: [parsed.item] } }
}

function append(target: JsonObject, source: Record<string, unknown>, field: string): void {
  const value = source[field]
  if (value === undefined || value === null) return
  if (typeof value !== 'string') fail('DeepSeek', `invalid ${field} delta`)
  const previous = target[field]
  target[field] = (typeof previous === 'string' ? previous : '') + value
  if ((target[field] as string).length > MAX_ARGUMENT_CHARS) fail('DeepSeek', 'stream value exceeded the size limit')
}

function identity(target: JsonObject, source: Record<string, unknown>, field: 'id' | 'name'): void {
  if (source[field] === undefined || source[field] === null) return
  const value = identifier(source[field], 'DeepSeek', field === 'id' ? 'tool call ID' : 'tool name')
  if (target[field] !== undefined && target[field] !== value) fail('DeepSeek', 'conflicting streamed tool identity')
  target[field] = value
}

class ChatStream {
  readonly message: JsonObject = { role: 'assistant', content: null }
  readonly calls = new Map<number, JsonObject>()
  finish: string | undefined
  counts: unknown

  async add(value: Record<string, unknown>, progress: (text: string) => Promise<void>): Promise<void> {
    throwIfContextOverflow(value, 'DeepSeek')
    if (value.error) fail('DeepSeek', 'agent response was not completed')
    if (!Array.isArray(value.choices) || value.choices.length !== 1) fail('DeepSeek', 'invalid stream choices')
    const choice = value.choices[0]
    throwIfContextOverflow(choice, 'DeepSeek')
    if (!isRecord(choice) || choice.error || (choice.index !== undefined && choice.index !== 0) ||
        !isRecord(choice.delta)) fail('DeepSeek', 'invalid stream choice')
    const delta = choice.delta
    // The official final-chunk example uses role:null; null carries no new role.
    if (delta.role !== undefined && delta.role !== null && delta.role !== 'assistant') fail('DeepSeek', 'invalid assistant role')
    if (this.finish && Object.entries(delta).some(([field, data]) => field !== 'role' &&
        data !== undefined && data !== null && data !== '' && !(Array.isArray(data) && !data.length))) {
      fail('DeepSeek', 'content arrived after stream completion')
    }
    append(this.message, delta, 'reasoning_content')
    append(this.message, delta, 'content')
    if (typeof delta.content === 'string') await progress(delta.content)
    if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
      if (!Array.isArray(delta.tool_calls)) fail('DeepSeek', 'invalid tool call deltas')
      for (const part of delta.tool_calls) {
        if (!isRecord(part) || !Number.isSafeInteger(part.index) ||
            (part.index as number) < 0 || (part.index as number) >= MAX_ITEMS) fail('DeepSeek', 'invalid tool call index')
        const index = part.index as number
        let call = this.calls.get(index)
        if (!call) { call = { type: 'function', function: {} }; this.calls.set(index, call) }
        if (part.type !== undefined && part.type !== 'function') fail('DeepSeek', 'invalid function call type')
        identity(call, part, 'id')
        if (part.function !== undefined) {
          if (!isRecord(part.function)) fail('DeepSeek', 'invalid function delta')
          identity(call.function as JsonObject, part.function, 'name')
          append(call.function as JsonObject, part.function, 'arguments')
        }
      }
    }
    if (value.usage !== undefined && value.usage !== null) this.counts = value.usage
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (choice.finish_reason !== 'stop' && choice.finish_reason !== 'tool_calls') fail('DeepSeek', 'agent response was not completed')
      if (this.finish && this.finish !== choice.finish_reason) fail('DeepSeek', 'conflicting stream finish reason')
      this.finish = choice.finish_reason
    }
  }

  completed(): Record<string, unknown> {
    if (!this.finish) fail('DeepSeek', 'agent response was not completed')
    const calls = [...this.calls.entries()].sort(([a], [b]) => a - b)
    if (calls.some(([index], position) => index !== position)) fail('DeepSeek', 'incomplete tool call indices')
    if (calls.length) this.message.tool_calls = calls.map(([, call]) => call)
    return { choices: [{ message: this.message, finish_reason: this.finish }], usage: this.counts }
  }
}

function requestBody(config: Config, input: { messages: readonly HistoryMessage[]; tools: readonly ToolDefinition[] },
  options?: Pick<ProviderGenerateOptions, 'maxOutputTokens' | 'purpose'>): JsonObject {
  const limit = outputTokenLimit('DeepSeek', options)
  const tools = options?.purpose === 'context-summary' ? [] : input.tools
  const thinking = !config.reasoning || config.reasoning.effort !== undefined
  return { model: config.model, messages: projectDeepSeekHistory(input.messages, config.model, { tools: tools.length > 0, thinking }),
    ...(tools.length ? { tools: tools.map((tool) => ({ type: 'function', function: {
      name: tool.name, description: tool.description, parameters: tool.parameters
    } })) } : {}),
    stream: config.stream,
    ...(config.stream ? { stream_options: { include_usage: true } } : {}),
    ...(config.reasoning?.effort ? { reasoning_effort: config.reasoning.effort }
      : config.reasoning ? { thinking: { type: 'disabled' } } : {}),
    ...(limit !== undefined ? { max_tokens: limit } : {}) }
}

/** DeepSeek Chat Completions. Defaults are server-owned; this never creates a reviewer. */
export function createDeepSeekProvider(options: DeepSeekProviderOptions): ModelProvider {
  const config = configure(options, 'DeepSeek', 'https://api.deepseek.com', 'chat/completions',
    ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  return {
    estimateContext(input, options) { return estimateRequestContext(requestBody(config, input, options)) },
    generate(input, signal, options) {
      const reservedIds = reservedToolCallIds('DeepSeek', options)
      return request(config, signal, options, async (context, key) => {
        const body = requestBody(config, input, options)
        const response = await post(config, context, key, body)
        const allowTools = Array.isArray(body.tools) && body.tools.length > 0
        const requireReasoning = allowTools && (!config.reasoning || config.reasoning.effort !== undefined)
        const finish = (value: unknown): ProviderResult => result(value, config.model, input.messages, reservedIds, allowTools, requireReasoning)
        if (!config.stream) return finish(await readJson(response, context, 'DeepSeek'))
        const stream = new ChatStream()
        return readSse(response, context, 'DeepSeek', async (frame) => {
          if (frame.event === 'error') {
            const event = eventJson(frame, 'DeepSeek')
            throwIfContextOverflow(event, 'DeepSeek')
            fail('DeepSeek', 'agent response was not completed')
          }
          if (frame.data === '[DONE]') return finish(stream.completed())
          const event = eventJson(frame, 'DeepSeek')
          await stream.add(event, (text) => context.progress(text))
          return undefined
        })
      })
    }
  }
}
