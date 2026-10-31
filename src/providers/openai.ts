// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import type { HistoryMessage, JsonObject, ModelProvider, ProviderResult, ToolDefinition } from '../types.js'
import { fail, isRecord, normalizeCallIds, parseOpenAiOutput, usage } from './shared.js'
import { configure, eventJson, outputTokenLimit, post, readJson, readSse, request, reservedToolCallIds, throwIfContextOverflow, responseFailure } from './transport.js'
import { captureImageOptions, estimateImageRequestContext } from './images.js'
import type { ImageProjectionOptions } from './images.js'
import { assertJson } from '../validation.js'
import type { Config, ProgressOptions, ProviderOptions } from './transport.js'

export { projectOpenAiHistory } from './shared.js'
export { ProviderRequestError, isContextOverflow } from './transport.js'
export type { ReasoningSelection, ProviderErrorDetails } from './transport.js'
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type EnabledReasoningEffort = Exclude<ReasoningEffort, 'none'>
export type OpenAIProviderOptions = ProviderOptions<EnabledReasoningEffort> & ImageProjectionOptions & {
  /** Trusted host-owned, pure wire compatibility projection, shared by estimation and generation.
   * The returned body must be JSON data and retain the configured model and stream mode.
   * The host owns route-specific policy; credentials never enter this callback. */
  transformRequest?: (body: JsonObject) => JsonObject
}
import { projectOpenAiHistory } from './shared.js'

function result(value: unknown, config: Config, key: string, messages: readonly HistoryMessage[], reservedIds: readonly string[] = [], requestId?: string, status?: number): ProviderResult {
  if (!isRecord(value)) fail('OpenAI', 'response must be an object')
  if (value.error || value.incomplete_details || value.status !== 'completed') {
    throwIfContextOverflow(value, 'OpenAI')
    throw responseFailure(config, value, key, status, requestId)
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
    providerState: { provider: `openai:${config.model}`, items: parsed.items }
  }
}

/** Build once for both the wire request and its context estimate. */
function requestBody(
  config: Config, images: ImageProjectionOptions,
  input: { messages: readonly HistoryMessage[]; tools: readonly ToolDefinition[] },
  options?: { maxOutputTokens?: number }, estimateImages = false,
  transform?: OpenAIProviderOptions['transformRequest']
): JsonObject {
  const maxOutputTokens = outputTokenLimit('OpenAI', options)
  const body: JsonObject = {
    model: config.model, input: projectOpenAiHistory(input.messages, config.model, images, estimateImages),
    ...(input.tools.length ? {
      tools: input.tools.map((tool) => ({ type: 'function', ...tool, strict: false })), tool_choice: 'auto'
    } : {}),
    store: false, include: ['reasoning.encrypted_content'],
    stream: config.stream, ...(config.reasoning ? { reasoning: config.reasoning } : {}),
    ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {})
  }
  if (!transform) return body
  let projected: JsonObject
  try {
    projected = transform(body)
    assertJson(projected)
    if (!isRecord(projected) || projected.model !== config.model || projected.stream !== config.stream) throw new Error()
    return structuredClone(projected)
  } catch {
    fail('OpenAI', 'request projection must return JSON data with the configured model and stream mode')
  }
}

/** OpenAI Responses API, with host-owned capabilities and no hidden retry policy. */
export function createOpenAIProvider(options: OpenAIProviderOptions): ModelProvider {
  const config = configure(options, 'OpenAI', 'https://api.openai.com/v1', 'responses',
    ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  const images = captureImageOptions('OpenAI', config.model, options)
  const transform = options.transformRequest
  if (transform !== undefined && typeof transform !== 'function') fail('OpenAI', 'request projection must be a function')
  return {
    estimateContext(input, options) {
      return estimateImageRequestContext(requestBody(config, images, input, options, true, transform), input.messages)
    },
    generate(input, signal, progress?: ProgressOptions) {
      const reservedIds = reservedToolCallIds('OpenAI', progress)
      return request(config, signal, progress, async (context, key) => {
        const body = requestBody(config, images, input, progress, false, transform)
        const response = await post(config, context, key, body)
        if (!config.stream) return result(await readJson(response, context, 'OpenAI'), config, key, input.messages, reservedIds, response.headers.get('x-request-id') ?? undefined, response.status)
        return readSse(response, context, 'OpenAI', async (frame) => {
          const event = eventJson(frame, 'OpenAI')
          if (event.error || event.type === 'error' || frame.event === 'error' ||
              event.type === 'response.failed' || event.type === 'response.incomplete') {
            throwIfContextOverflow(event, 'OpenAI')
            throw responseFailure(config, event, key, response.status, response.headers.get('x-request-id') ?? undefined)
          }
          if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
            if (typeof event.delta !== 'string') fail('OpenAI', 'text delta must be a string')
            await context.progress(event.delta)
          }
          if (event.type === 'response.completed') {
            return result(event.response, config, key, input.messages, reservedIds, response.headers.get('x-request-id') ?? undefined, response.status)
          }
          return undefined
        })
      })
    }
  }
}
