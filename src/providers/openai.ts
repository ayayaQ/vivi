// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import type { HistoryMessage, JsonObject, ModelProvider, ProviderResult, ToolDefinition } from '../types.js'
import { fail, isRecord, normalizeCallIds, parseOpenAiOutput, usage } from './shared.js'
import { configure, estimateRequestContext, eventJson, outputTokenLimit, post, readJson, readSse, request, reservedToolCallIds, throwIfContextOverflow } from './transport.js'
import type { Config, ProgressOptions, ProviderOptions } from './transport.js'

export { projectOpenAiHistory } from './shared.js'
export { ProviderRequestError, isContextOverflow } from './transport.js'
export type { ReasoningSelection } from './transport.js'
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type EnabledReasoningEffort = Exclude<ReasoningEffort, 'none'>
export type OpenAIProviderOptions = ProviderOptions<EnabledReasoningEffort>
import { projectOpenAiHistory } from './shared.js'

function result(value: unknown, model: string, messages: readonly HistoryMessage[], reservedIds: readonly string[] = []): ProviderResult {
  if (!isRecord(value)) fail('OpenAI', 'response must be an object')
  if (value.error || value.incomplete_details || value.status !== 'completed') {
    throwIfContextOverflow(value, 'OpenAI')
    fail('OpenAI', 'agent response was not completed')
  }
  const parsed = parseOpenAiOutput(value.output)
  normalizeCallIds(parsed.toolCalls, messages, 'OpenAI', false, reservedIds)
  if (value.output_text !== undefined && typeof value.output_text !== 'string') {
    fail('OpenAI', 'output text must be a string')
  }
  // Canonical content follows native message parts, including refusals, for exact replay.
  const content = parsed.content || (typeof value.output_text === 'string' ? value.output_text : '')
  const tokenUsage = usage(value.usage, 'OpenAI')
  return {
    content, toolCalls: parsed.toolCalls, ...(tokenUsage !== undefined ? { usage: tokenUsage } : {}),
    providerState: { provider: `openai:${model}`, items: parsed.items }
  }
}

/** Build once for both the wire request and its context estimate. */
function requestBody(
  config: Config,
  input: { messages: readonly HistoryMessage[]; tools: readonly ToolDefinition[] },
  options?: { maxOutputTokens?: number }
): JsonObject {
  const maxOutputTokens = outputTokenLimit('OpenAI', options)
  return {
    model: config.model, input: projectOpenAiHistory(input.messages, config.model),
    ...(input.tools.length ? {
      tools: input.tools.map((tool) => ({ type: 'function', ...tool, strict: false })), tool_choice: 'auto'
    } : {}),
    store: false, include: ['reasoning.encrypted_content'],
    stream: config.stream, ...(config.reasoning ? { reasoning: config.reasoning } : {}),
    ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {})
  }
}

/** OpenAI Responses API, with host-owned capabilities and no hidden retry policy. */
export function createOpenAIProvider(options: OpenAIProviderOptions): ModelProvider {
  const config = configure(options, 'OpenAI', 'https://api.openai.com/v1', 'responses',
    ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  return {
    estimateContext(input, options) {
      return estimateRequestContext(requestBody(config, input, options))
    },
    generate(input, signal, progress?: ProgressOptions) {
      const reservedIds = reservedToolCallIds('OpenAI', progress)
      return request(config, signal, progress, async (context, key) => {
        const body = requestBody(config, input, progress)
        const response = await post(config, context, key, body)
        if (!config.stream) return result(await readJson(response, context, 'OpenAI'), config.model, input.messages, reservedIds)
        return readSse(response, context, 'OpenAI', async (frame) => {
          const event = eventJson(frame, 'OpenAI')
          if (event.error || event.type === 'error' || frame.event === 'error' ||
              event.type === 'response.failed' || event.type === 'response.incomplete') {
            throwIfContextOverflow(event, 'OpenAI')
            fail('OpenAI', 'agent response was not completed')
          }
          if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
            if (typeof event.delta !== 'string') fail('OpenAI', 'text delta must be a string')
            await context.progress(event.delta)
          }
          if (event.type === 'response.completed') {
            return result(event.response, config.model, input.messages, reservedIds)
          }
          return undefined
        })
      })
    }
  }
}
