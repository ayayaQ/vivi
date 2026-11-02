// SPDX-License-Identifier: Apache-2.0
import openai = require('@ayayaq/vivi/providers/openai')
import core = require('@ayayaq/vivi')
const projection: NonNullable<openai.OpenAIProviderOptions['transformRequest']> = body => {
  const result: core.JsonObject = { ...body }
  delete result.max_output_tokens
  return result
}
const options: openai.OpenAIProviderOptions = { model: 'offline', apiKey: async () => 'offline-key', stream: true,
  transformRequest: projection, errorDetails: true, fetch: async () => new Response('offline') }
const provider: core.ModelProvider = openai.createOpenAIProvider(options)
const details: openai.ProviderErrorDetails = { bodyShape: 'detail', code: 'safe_code', param: 'model', requestId: 'req_offline' }
const shape: 'error' | 'detail' | 'other' | 'unreadable' = details.bodyShape
function inspect(error: openai.ProviderRequestError): void {
  const status: number | undefined = error.status
  const diagnostic: Readonly<openai.ProviderErrorDetails> | undefined = error.details
  // @ts-expect-error captured provider diagnostics are readonly
  error.details!.param = 'mutated'
  void [status, diagnostic]
}
// @ts-expect-error request projections must be synchronous JSON projections
const asyncProjection: openai.OpenAIProviderOptions['transformRequest'] = async body => body
// @ts-expect-error diagnostics opt-in is a boolean
const invalidOptions: openai.OpenAIProviderOptions = { model: 'offline', apiKey: 'offline', errorDetails: 1 }
// @ts-expect-error body shape is a closed discriminator
const invalidShape: openai.ProviderErrorDetails = { bodyShape: 'raw-provider-body' }
void [provider, details, shape, inspect, asyncProjection, invalidOptions, invalidShape]

// Compile-only public consumer: input, options, estimate, send and progress stay typed.
function consume(input: Parameters<core.ModelProvider['generate']>[0]): void {
  const estimate: core.ContextEstimate | undefined = provider.estimateContext?.(input, { maxOutputTokens: 37 })
  const sent: Promise<core.ProviderResult> = provider.generate(
    input, new AbortController().signal, { maxOutputTokens: 37, purpose: 'context-summary',
      async onProgress(event) {
        const kind: 'text_delta' = event.type
        const text: string = event.text
        void [kind, text]
      } })
  void [estimate, sent]
}
// @ts-expect-error a projection cannot return a non-JSON undefined field
const nonJsonProjection: openai.OpenAIProviderOptions['transformRequest'] = body => ({ ...body, invalid: undefined })
// @ts-expect-error estimates and sends share a numeric output bound
provider.estimateContext?.({ messages: [], tools: [] }, { maxOutputTokens: '37' })
void [consume, nonJsonProjection]
