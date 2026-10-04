// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import type { HistoryMessage, JsonObject, ModelProvider, ProviderResult } from '../types.js'
import { fail, isRecord, normalizeCallIds, parseOpenAiOutput, usage } from './shared.js'
import { configure, eventJson, post, readJson, readSse, request } from './transport.js'
import type { ProgressOptions, ProviderOptions } from './transport.js'

export { projectOpenAiHistory } from './shared.js'
export { ProviderRequestError } from './transport.js'
export type { ReasoningSelection } from './transport.js'
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type EnabledReasoningEffort = Exclude<ReasoningEffort, 'none'>
export type OpenAIProviderOptions = ProviderOptions<EnabledReasoningEffort>
import { projectOpenAiHistory } from './shared.js'

function result(value: unknown, model: string, messages: readonly HistoryMessage[]): ProviderResult {
  if (!isRecord(value)) fail('OpenAI', 'response must be an object')
  if (value.error || value.incomplete_details || value.status !== 'completed') {
    fail('OpenAI', 'agent response was not completed')
  }
  const parsed = parseOpenAiOutput(value.output)
  normalizeCallIds(parsed.toolCalls, messages, 'OpenAI')
  if (value.output_text !== undefined && typeof value.output_text !== 'string') {
    fail('OpenAI', 'output text must be a string')
  }
  // Canonical content follows native message parts, including refusals, for exact replay.
  const content = parsed.content || (typeof value.output_text === 'string' ? value.output_text : '')
  return {
    content, toolCalls: parsed.toolCalls, usage: usage(value.usage, 'OpenAI'),
    providerState: { provider: `openai:${model}`, items: parsed.items }
  }
}

/** OpenAI Responses API, with host-owned capabilities and no hidden retry policy. */
export function createOpenAIProvider(options: OpenAIProviderOptions): ModelProvider {
  const config = configure(options, 'OpenAI', 'https://api.openai.com/v1', 'responses',
    ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  return {
    generate(input, signal, progress?: ProgressOptions) {
      return request(config, signal, progress, async (context, key) => {
        const body: JsonObject = {
          model: config.model, input: projectOpenAiHistory(input.messages, config.model),
          ...(input.tools.length ? {
            tools: input.tools.map((tool) => ({ type: 'function', ...tool, strict: false })), tool_choice: 'auto'
          } : {}),
          store: false, include: ['reasoning.encrypted_content'],
          stream: config.stream, ...(config.reasoning ? { reasoning: config.reasoning } : {})
        }
        const response = await post(config, context, key, body)
        if (!config.stream) return result(await readJson(response, context, 'OpenAI'), config.model, input.messages)
        return readSse(response, context, 'OpenAI', async (frame) => {
          const event = eventJson(frame, 'OpenAI')
          if (event.error || event.type === 'error' || frame.event === 'error' ||
              event.type === 'response.failed' || event.type === 'response.incomplete') {
            fail('OpenAI', 'agent response was not completed')
          }
          if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
            if (typeof event.delta !== 'string') fail('OpenAI', 'text delta must be a string')
            await context.progress(event.delta)
          }
          if (event.type === 'response.completed') {
            return result(event.response, config.model, input.messages)
          }
          return undefined
        })
      })
    }
  }
}
