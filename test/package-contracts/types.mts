// SPDX-License-Identifier: Apache-2.0
import { createOpenAIProvider, ProviderRequestError } from '@ayayaq/vivi/providers/openai'
import type { OpenAIProviderOptions, ProviderErrorDetails } from '@ayayaq/vivi/providers/openai'
import type { JsonObject, ModelProvider } from '@ayayaq/vivi'
const projection: NonNullable<OpenAIProviderOptions['transformRequest']> = body => {
  const result: JsonObject = { ...body }
  delete result.max_output_tokens
  return result
}
const options: OpenAIProviderOptions = { model: 'offline', apiKey: async () => 'offline-key', stream: true,
  transformRequest: projection, errorDetails: true, fetch: async () => new Response('offline') }
const provider: ModelProvider = createOpenAIProvider(options)
const details: ProviderErrorDetails = { bodyShape: 'error', code: 'safe_code', param: 'input[0]', requestId: 'req_offline' }
const shape: 'error' | 'detail' | 'other' | 'unreadable' = details.bodyShape
function inspect(error: ProviderRequestError): void {
  const status: number | undefined = error.status
  const diagnostic: Readonly<ProviderErrorDetails> | undefined = error.details
  // @ts-expect-error captured provider diagnostics are readonly
  error.details!.code = 'mutated'
  void [status, diagnostic]
}
// @ts-expect-error request projections must be synchronous JSON projections
const asyncProjection: OpenAIProviderOptions['transformRequest'] = async body => body
// @ts-expect-error diagnostics opt-in is a boolean
const invalidOptions: OpenAIProviderOptions = { model: 'offline', apiKey: 'offline', errorDetails: 'yes' }
// @ts-expect-error body shape is a closed discriminator
const invalidShape: ProviderErrorDetails = { bodyShape: 'raw-provider-body' }
void [provider, details, shape, inspect, asyncProjection, invalidOptions, invalidShape]

// Compile-only public consumer: input, options, estimate, send and progress stay typed.
function consume(input: Parameters<ModelProvider['generate']>[0]): void {
  const estimate: import('@ayayaq/vivi').ContextEstimate | undefined =
    provider.estimateContext?.(input, { maxOutputTokens: 37 })
  const sent: Promise<import('@ayayaq/vivi').ProviderResult> = provider.generate(
    input, new AbortController().signal, { maxOutputTokens: 37, purpose: 'context-summary',
      async onProgress(event) {
        const kind: 'text_delta' = event.type
        const text: string = event.text
        void [kind, text]
      } })
  void [estimate, sent]
}
// @ts-expect-error a projection cannot return a non-JSON undefined field
const nonJsonProjection: OpenAIProviderOptions['transformRequest'] = body => ({ ...body, invalid: undefined })
// @ts-expect-error estimates and sends share a numeric output bound
provider.estimateContext?.({ messages: [], tools: [] }, { maxOutputTokens: '37' })
void [consume, nonJsonProjection]
