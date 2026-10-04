// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import type { HistoryMessage, JsonObject, ModelProvider, ProviderResult } from '../types.js'
import {
  fail, identifier, isJsonValue, isRecord, MAX_ARGUMENT_CHARS, MAX_ITEMS,
  normalizeCallIds, parseOpenRouterMessage, parseReasoningDetail, projectOpenRouterHistory, usage
} from './shared.js'
import { configure, eventJson, post, readJson, readSse, request, ProviderRequestError } from './transport.js'
import type { ProgressOptions, ProviderOptions } from './transport.js'

export { projectOpenRouterHistory } from './shared.js'
export { ProviderRequestError } from './transport.js'
export type { ReasoningEffort, EnabledReasoningEffort, ReasoningSelection } from './transport.js'
export interface OpenRouterProviderOptions extends ProviderOptions {
  attribution?: { referer?: string; title?: string }
  /** Opt in to routing only to endpoints that support every supplied parameter. Default false. */
  requireSupportedParameters?: boolean
}

function result(value: unknown, model: string, messages: readonly HistoryMessage[]): ProviderResult {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length !== 1 || !isRecord(value.choices[0])) {
    fail('OpenRouter', 'response contained no single agent message')
  }
  const choice = value.choices[0]
  if (value.error || choice.error || (choice.finish_reason !== 'stop' && choice.finish_reason !== 'tool_calls')) {
    fail('OpenRouter', 'agent response was not completed')
  }
  const parsed = parseOpenRouterMessage(choice.message)
  const hasReasoning = Boolean(parsed.item.reasoning || parsed.item.reasoning_content) ||
    (Array.isArray(parsed.item.reasoning_details) && parsed.item.reasoning_details.length > 0)
  if (normalizeCallIds(parsed.toolCalls, messages, 'OpenRouter', !hasReasoning)) {
    parsed.item.tool_calls = (parsed.item.tool_calls as JsonObject[]).map((call, index) => ({
      ...call, id: parsed.toolCalls[index]!.id
    }))
  }
  return {
    content: parsed.content, toolCalls: parsed.toolCalls, usage: usage(value.usage, 'OpenRouter'),
    providerState: { provider: `openrouter:${model}`, items: [parsed.item] }
  }
}

function append(target: JsonObject, source: Record<string, unknown>, field: string): void {
  const value = source[field]
  if (value === undefined || value === null) return
  if (typeof value !== 'string') fail('OpenRouter', `invalid ${field} delta`)
  const previous = target[field]
  target[field] = (typeof previous === 'string' ? previous : '') + value
  if ((target[field] as string).length > MAX_ARGUMENT_CHARS) fail('OpenRouter', 'stream value exceeded the size limit')
}

/** Tool identities are stable metadata; only the JSON arguments are streamed fragments. */
function identity(target: JsonObject, source: Record<string, unknown>, field: 'id' | 'name'): void {
  const value = source[field]
  if (value === undefined || value === null) return
  const next = identifier(value, 'OpenRouter', field === 'id' ? 'tool call ID' : 'tool name')
  if (target[field] !== undefined && target[field] !== next) {
    fail('OpenRouter', 'conflicting streamed tool identity')
  }
  target[field] = next
}

/** Assemble deltas without exposing executable calls before finish_reason and [DONE]. */
class ChatStream {
  readonly message: JsonObject = { role: 'assistant', content: null }
  readonly calls = new Map<number, JsonObject>()
  readonly reasoning: JsonObject[] = []
  finish: string | undefined
  tokenUsage: unknown

  async add(value: Record<string, unknown>, progress: (text: string) => Promise<void>): Promise<void> {
    if (value.error) fail('OpenRouter', 'agent response was not completed')
    if (value.usage !== undefined && value.usage !== null) this.tokenUsage = value.usage
    if (!Array.isArray(value.choices) || value.choices.length > 1) fail('OpenRouter', 'invalid stream choices')
    if (!value.choices.length) {
      if (value.usage === undefined) fail('OpenRouter', 'empty stream choices without usage')
      return
    }
    const choice = value.choices[0]
    if (!isRecord(choice) || choice.error || (choice.index !== undefined && choice.index !== 0)) {
      fail('OpenRouter', 'invalid stream choice')
    }
    if (!isRecord(choice.delta)) fail('OpenRouter', 'stream choice has no delta')
    const delta = choice.delta
    if (delta.role !== undefined && delta.role !== 'assistant') fail('OpenRouter', 'invalid assistant role')
    if (this.finish && Object.entries(delta).some(([field, data]) =>
      field !== 'role' && data !== null && data !== undefined && data !== '' &&
      !(Array.isArray(data) && data.length === 0))) {
      fail('OpenRouter', 'content arrived after stream completion')
    }
    for (const field of ['content', 'refusal', 'reasoning', 'reasoning_content']) {
      append(this.message, delta, field)
      if ((field === 'content' || field === 'refusal') && typeof delta[field] === 'string') {
        await progress(delta[field])
      }
    }
    if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
      if (!Array.isArray(delta.tool_calls)) fail('OpenRouter', 'invalid tool call deltas')
      for (const part of delta.tool_calls) {
        if (!isRecord(part) || !Number.isSafeInteger(part.index) ||
            (part.index as number) < 0 || (part.index as number) >= MAX_ITEMS) {
          fail('OpenRouter', 'invalid tool call index')
        }
        const index = part.index as number
        let call = this.calls.get(index)
        if (!call) { call = { type: 'function', function: {} }; this.calls.set(index, call) }
        if (part.type !== undefined && part.type !== 'function') fail('OpenRouter', 'invalid function call type')
        identity(call, part, 'id')
        if (part.function !== undefined) {
          if (!isRecord(part.function)) fail('OpenRouter', 'invalid function delta')
          identity(call.function as JsonObject, part.function, 'name')
          append(call.function as JsonObject, part.function, 'arguments')
        }
      }
    }
    if (delta.reasoning_details !== undefined && delta.reasoning_details !== null) {
      if (!Array.isArray(delta.reasoning_details)) fail('OpenRouter', 'invalid reasoning_details delta')
      for (const detail of delta.reasoning_details) this.addDetail(detail)
    }
    const finish = choice.finish_reason
    if (finish !== undefined && finish !== null) {
      if (finish !== 'stop' && finish !== 'tool_calls') fail('OpenRouter', 'agent response was not completed')
      if (this.finish && finish !== this.finish) fail('OpenRouter', 'conflicting stream finish reason')
      this.finish = finish
    }
  }

  private addDetail(value: unknown): void {
    if (!isRecord(value) || !isJsonValue(value)) fail('OpenRouter', 'invalid reasoning detail')
    const detail = parseReasoningDetail(value, true)
    const last = this.reasoning.at(-1)
    // OpenRouter can reuse indices across types. Its maintained SDK reassembles consecutive
    // text/summary blocks by type transition, and never merges opaque encrypted blocks.
    // https://github.com/OpenRouterTeam/ai-sdk-provider/blob/main/src/chat/index.ts
    if ((detail.type === 'reasoning.text' || detail.type === 'reasoning.summary') &&
        last?.type === detail.type) {
      const field = detail.type === 'reasoning.text' ? 'text' : 'summary'
      if (detail[field] === null && last[field] === undefined) last[field] = null
      else append(last, detail, field)
      for (const metadata of ['format', ...(detail.type === 'reasoning.text' ? ['signature'] : [])]) {
        // Signatures are opaque complete values, not text fragments. Retain the first nonempty
        // signature/format, while preserving explicit null when there is no populated value.
        if (!last[metadata] && detail[metadata] !== undefined) last[metadata] = detail[metadata]!
      }
      return
    }
    if (this.reasoning.length >= MAX_ITEMS) fail('OpenRouter', 'too many reasoning details')
    this.reasoning.push(detail)
  }

  completed(): Record<string, unknown> {
    if (!this.finish) fail('OpenRouter', 'agent response was not completed')
    const calls = [...this.calls.entries()].sort(([left], [right]) => left - right)
    if (calls.some(([index], position) => index !== position)) fail('OpenRouter', 'incomplete tool call indices')
    if (calls.length) this.message.tool_calls = calls.map(([, call]) => call)
    if (this.reasoning.length) this.message.reasoning_details = this.reasoning
    return { choices: [{ message: this.message, finish_reason: this.finish }], usage: this.tokenUsage }
  }
}

/** OpenRouter Chat Completions API. Native reasoning is retained for tool continuation. */
export function createOpenRouterProvider(options: OpenRouterProviderOptions): ModelProvider {
  const config = configure(options, 'OpenRouter', 'https://openrouter.ai/api/v1', 'chat/completions',
    ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  if (options.requireSupportedParameters !== undefined && typeof options.requireSupportedParameters !== 'boolean') {
    throw new ProviderRequestError('OpenRouter', 'configuration', 'OpenRouter requireSupportedParameters must be a boolean')
  }
  const requireSupportedParameters = options.requireSupportedParameters === true
  const headers: Record<string, string> = {}
  if (options.attribution !== undefined && (!options.attribution ||
      typeof options.attribution !== 'object' || Array.isArray(options.attribution))) {
    throw new ProviderRequestError('OpenRouter', 'configuration', 'OpenRouter attribution must be an object')
  }
  for (const [field, header] of [['referer', 'HTTP-Referer'], ['title', 'X-Title']] as const) {
    const value = options.attribution?.[field]
    if (value !== undefined) {
      if (typeof value !== 'string' || /[\r\n]/.test(value)) {
        throw new ProviderRequestError('OpenRouter', 'configuration', 'OpenRouter attribution must use valid header strings')
      }
      headers[header] = value
    }
  }
  return {
    generate(input, signal, progress?: ProgressOptions) {
      return request(config, signal, progress, async (context, key) => {
        // OpenRouter defaults to automatic tool choice. Omit that optional parameter so
        // strict routing does not require tool_choice support in addition to tools support.
        const body: JsonObject = {
          model: config.model, messages: projectOpenRouterHistory(input.messages, config.model),
          ...(input.tools.length ? { tools: input.tools.map((tool) => ({ type: 'function', function: {
            name: tool.name, description: tool.description, parameters: tool.parameters
          } })) } : {}),
          stream: config.stream,
          ...(config.stream ? { stream_options: { include_usage: true } } : {}),
          ...(config.reasoning ? { reasoning: config.reasoning } : {}),
          ...(requireSupportedParameters ? { provider: { require_parameters: true } } : {})
        }
        const response = await post(config, context, key, body, headers)
        if (!config.stream) return result(await readJson(response, context, 'OpenRouter'), config.model, input.messages)
        const stream = new ChatStream()
        return readSse(response, context, 'OpenRouter', async (frame) => {
          if (frame.event === 'error') fail('OpenRouter', 'agent response was not completed')
          if (frame.data === '[DONE]') return result(stream.completed(), config.model, input.messages)
          await stream.add(eventJson(frame, 'OpenRouter'), (text) => context.progress(text))
          return undefined
        })
      })
    }
  }
}
