// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import type { ContextEstimate, JsonObject, ProviderGenerateOptions } from '../types.js'
import type { Provider } from './shared.js'

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type EnabledReasoningEffort = Exclude<ReasoningEffort, 'none'>
export type ReasoningSelection<E extends EnabledReasoningEffort = EnabledReasoningEffort> =
  | { mode: 'default' }
  | { mode: 'disabled' }
  | { mode: 'effort'; effort: E }

/** The host owns credentials, model choice, model capabilities, and application attribution. */
export interface ProviderOptions<E extends EnabledReasoningEffort = EnabledReasoningEffort> {
  model: string
  apiKey: string | (() => string | Promise<string>)
  reasoning?: ReasoningSelection<E>
  /** Explicit model capabilities. Include 'none' only if this model supports disabling reasoning. */
  supportedReasoningEfforts?: readonly (E | 'none')[]
  /** End-to-end deadline, checked after synchronous work; default 60 seconds. */
  timeoutMs?: number
  /** Default false. Only text/refusal progress is emitted, never partial function calls. */
  stream?: boolean
  /** API root, e.g. https://api.openai.com/v1. The factory appends its endpoint path. */
  baseURL?: string
  /** Optional transport injection, useful for offline testing. No automatic retries are made. */
  fetch?: typeof fetch
  /** Opt-in bounded machine-readable upstream diagnostics. Never retains raw body text. */
  errorDetails?: boolean
}

export interface ProviderErrorDetails {
  code?: string
  param?: string
  requestId?: string
  /** Shape of the received JSON body, not its potentially sensitive values. */
  bodyShape: 'error' | 'detail' | 'other' | 'unreadable'
}

export type ProgressOptions = ProviderGenerateOptions

/** Sanitized errors never retain raw response bodies, credential values, URLs, or causes. */
export class ProviderRequestError extends Error {
  constructor(
    readonly provider: Provider,
    readonly code: 'configuration' | 'http' | 'transport' | 'invalid_response' | 'timeout' | 'aborted' | 'context_overflow',
    message: string,
    readonly status?: number,
    readonly details?: Readonly<ProviderErrorDetails>
  ) {
    super(message)
    this.name = code === 'aborted' ? 'AbortError' : 'ProviderRequestError'
  }
}

export { isContextOverflow } from '../validation.js'

function dataField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

/** Only explicit machine-readable overflow identifiers trigger context recovery.
 * OpenRouter additionally carries the canonical identifier in error.metadata.error_type.
 * Message text, raw upstream bodies, generic token limits, and HTTP status alone do not.
 */
export function throwIfContextOverflow(value: unknown, provider: Provider, status?: number): void {
  const error = dataField(value, 'error')
  const responseError = dataField(dataField(value, 'response'), 'error')
  const candidates = [value, error, responseError]
  for (const candidate of candidates) {
    const metadata = dataField(candidate, 'metadata')
    if ([dataField(candidate, 'code'), dataField(candidate, 'type'),
      dataField(candidate, 'error_type'), dataField(metadata, 'error_type')]
      .some((code) => code === 'context_length_exceeded')) {
      throw new ProviderRequestError(provider, 'context_overflow', `${provider} request exceeded the context window`, status)
    }
  }
}

/** Same validated output bound is used by generation and effective-request estimation. */
export function outputTokenLimit(provider: Provider, options?: { maxOutputTokens?: number }): number | undefined {
  const limit = options?.maxOutputTokens
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new ProviderRequestError(provider, 'configuration', `${provider} maxOutputTokens must be a positive safe integer`)
  }
  return limit
}

/** Preserve canonical identities that are no longer visible in a compacted provider view. */
export function reservedToolCallIds(provider: Provider, options?: ProviderGenerateOptions): readonly string[] {
  const ids = options?.reservedToolCallIds
  if (ids === undefined) return []
  const invalid = (): never => { throw new ProviderRequestError(provider, 'configuration', `${provider} reservedToolCallIds must contain canonical identifier strings`) }
  if (!Array.isArray(ids)) invalid()
  const captured: string[] = []
  for (let index = 0; index < ids.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(ids, String(index))
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string' ||
      !descriptor.value || descriptor.value !== descriptor.value.trim()) invalid()
    captured.push(descriptor!.value as string)
  }
  return Object.freeze(captured)
}

/** Approximate the final projected prompt, not transport bytes or cumulative billing.
 * ASCII uses three bytes/token, non-ASCII two, plus framing allowances. This is a
 * conservative multilingual heuristic, not a tokenizer or guaranteed upper bound.
 * In particular, opaque native reasoning cannot be measured exactly from its encoding.
 */
export function estimateRequestContext(body: JsonObject): ContextEstimate {
  const prompt: JsonObject = {}
  for (const key of ['input', 'messages', 'tools', 'tool_choice', 'reasoning']) {
    if (body[key] !== undefined) prompt[key] = body[key]!
  }
  const text = JSON.stringify(prompt)
  let ascii = 0
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) < 128) ascii++
  const bytes = new TextEncoder().encode(text).byteLength
  const messages = body.input ?? body.messages
  const framing = 32 + (Array.isArray(messages) ? messages.length * 8 : 0) +
    (Array.isArray(body.tools) ? body.tools.length * 16 : 0)
  return { inputTokens: Math.ceil(ascii / 3 + (bytes - ascii) / 2) + framing, estimated: true }
}

export interface Config {
  provider: Provider
  model: string
  apiKey: ProviderOptions['apiKey']
  reasoning?: JsonObject
  timeoutMs: number
  stream: boolean
  endpoint: string
  fetch: typeof fetch
  errorDetails: boolean
}

export function configure(
  options: ProviderOptions,
  provider: Provider,
  baseURL: string,
  path: string,
  allowedEfforts: readonly EnabledReasoningEffort[]
): Config {
  const invalid = (detail: string): never => {
    throw new ProviderRequestError(provider, 'configuration', `${provider} configuration: ${detail}`)
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    invalid('options must be an object')
  }
  if (typeof options.model !== 'string' || !options.model || /\s/.test(options.model)) {
    invalid('model must be a non-empty identifier')
  }
  if (typeof options.apiKey !== 'function' &&
      (typeof options.apiKey !== 'string' || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey))) {
    invalid('API key must be a non-empty string or resolver')
  }
  const timeoutMs = options.timeoutMs === undefined ? 60_000 : options.timeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    invalid('timeoutMs must be an integer from 1 to 2147483647')
  }
  if (options.stream !== undefined && typeof options.stream !== 'boolean') {
    invalid('stream must be a boolean')
  }
  if (options.errorDetails !== undefined && typeof options.errorDetails !== 'boolean') invalid('errorDetails must be a boolean')
  const capabilities = options.supportedReasoningEfforts
  if (capabilities !== undefined && (!Array.isArray(capabilities) ||
      capabilities.some((effort) => effort !== 'none' && !allowedEfforts.includes(effort)))) {
    invalid('supportedReasoningEfforts contains an unsupported effort')
  }
  let reasoning: JsonObject | undefined
  const selection: ReasoningSelection = options.reasoning === undefined ? { mode: 'default' } : options.reasoning
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) invalid('reasoning must be an object')
  if (selection.mode === 'effort') {
    if (!allowedEfforts.includes(selection.effort) || !capabilities?.includes(selection.effort)) {
      invalid('selected reasoning effort requires explicit model capability support')
    }
    reasoning = { effort: selection.effort, ...(provider === 'OpenRouter' ? { exclude: false } : {}) }
  } else if (selection.mode === 'disabled') {
    if (!capabilities?.includes('none')) invalid('disabling reasoning requires explicit model capability support')
    reasoning = provider === 'OpenAI' ? { effort: 'none' } : { enabled: false }
  } else if (selection.mode !== 'default') {
    invalid('invalid reasoning mode')
  }
  let endpoint: string
  try {
    const url = new URL(options.baseURL === undefined ? baseURL : options.baseURL)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) {
      invalid('baseURL must be an HTTP(S) API root without credentials, query, or fragment')
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path}`
    endpoint = url.toString()
  } catch {
    invalid('baseURL must be an HTTP(S) API root without credentials, query, or fragment')
  }
  const fetchImpl = options.fetch === undefined ? globalThis.fetch : options.fetch
  if (typeof fetchImpl !== 'function') invalid('fetch transport is unavailable')
  return {
    provider, model: options.model, apiKey: options.apiKey, timeoutMs,
    stream: options.stream ?? false, endpoint: endpoint!, fetch: fetchImpl, errorDetails: options.errorDetails ?? false,
    ...(reasoning ? { reasoning } : {})
  }
}

class CallbackFailure {
  constructor(readonly original: unknown) {}
}

export interface RequestContext {
  signal: AbortSignal
  check(): void
  progress(text: string): Promise<void>
}

/** Race even an abort-ignoring injected transport; quarantine its late output and callbacks. */
export async function request<T>(
  config: Config,
  signal: AbortSignal,
  progress: ProgressOptions | undefined,
  operation: (context: RequestContext, key: string) => Promise<T>
): Promise<T> {
  const startedAt = performance.now()
  const controller = new AbortController()
  let active = true
  let timedOut = false
  const abortError = (): ProviderRequestError => new ProviderRequestError(
    config.provider, timedOut ? 'timeout' : 'aborted',
    `${config.provider} request ${timedOut ? 'timed out' : 'cancelled'}`
  )
  const abort = (): void => controller.abort()
  const check = (): void => {
    if (!active || controller.signal.aborted) throw abortError()
    // Timers cannot run while synchronous callbacks/parsing occupy the event loop.
    // Use monotonic elapsed time at boundaries so their late output is never accepted.
    if (performance.now() - startedAt >= config.timeoutMs) {
      timedOut = true
      abort()
      throw abortError()
    }
  }
  let rejectAborted: (reason: unknown) => void = () => {}
  const aborted = new Promise<never>((_, reject) => { rejectAborted = reject })
  const onAbort = (): void => rejectAborted(abortError())
  controller.signal.addEventListener('abort', onAbort, { once: true })
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) { timedOut = true; abort() }
  }, config.timeoutMs)
  if (signal.aborted) abort()
  const context: RequestContext = {
    signal: controller.signal,
    check,
    async progress(text) {
      check()
      if (!text || !progress?.onProgress) return
      try {
        await progress.onProgress(Object.freeze({ type: 'text_delta', text }))
      } catch (error) {
        throw new CallbackFailure(error)
      }
      check()
    }
  }
  try {
    const work = (async () => {
      check()
      let key: unknown
      try {
        key = typeof config.apiKey === 'function' ? await config.apiKey() : config.apiKey
      } catch {
        check()
        throw new ProviderRequestError(config.provider, 'configuration', `${config.provider} credential resolution failed`)
      }
      check()
      if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) {
        throw new ProviderRequestError(config.provider, 'configuration', `${config.provider} API key is not configured`)
      }
      check()
      const result = await operation(context, key)
      check()
      return result
    })()
    return await Promise.race([work, aborted])
  } catch (error) {
    if (error instanceof CallbackFailure) throw error.original
    check()
    if (error instanceof ProviderRequestError) throw error
    throw new ProviderRequestError(config.provider, 'transport', `${config.provider} request failed`)
  } finally {
    active = false
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', onAbort)
    // Release live network/body work if parsing or a progress callback failed.
    controller.abort()
  }
}

export async function post(
  config: Config, context: RequestContext, key: string, body: JsonObject,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  context.check()
  const headers = { ...extraHeaders, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  const serializedBody = JSON.stringify(body)
  context.check()
  const response = await config.fetch(config.endpoint, {
    method: 'POST', signal: context.signal, redirect: 'error',
    headers, body: serializedBody
  })
  try { context.check() } catch (error) {
    if (response.body) void response.body.cancel().catch(() => {})
    throw error
  }
  if (!response.ok) {
    const error = await readHttpError(response, context)
    throwIfContextOverflow(error, config.provider, response.status)
    throw responseFailure(config, error, key, response.status, response.headers.get('x-request-id') ?? undefined, 'http')
  }
  return response
}


/** Optional diagnostics contain only bounded protocol identifiers; no raw message, body or cause. */
export function responseFailure(config: Config, value: unknown, key: string, status?: number,
  requestId?: string, code: 'http' | 'invalid_response' = 'invalid_response'): ProviderRequestError {
  let details: ProviderErrorDetails | undefined
  if (config.errorDetails) {
    const nested = dataField(dataField(value, 'response'), 'error')
    const error = dataField(value, 'error') ?? nested
    const candidate = error !== undefined ? error : value
    const safe = (input: unknown): string | undefined => typeof input === 'string' &&
      /^[a-zA-Z0-9_.:\[\]-]{1,200}$/.test(input) && !input.includes(key) ? input : undefined
    const upstreamCode = safe(dataField(candidate, 'code'))
    const param = safe(dataField(candidate, 'param'))
    const id = safe(requestId)
    details = Object.freeze({
      bodyShape: error !== undefined ? 'error' : dataField(value, 'detail') !== undefined ? 'detail'
        : value === undefined ? 'unreadable' : 'other',
      ...(upstreamCode ? { code: upstreamCode } : {}), ...(param ? { param } : {}),
      ...(id ? { requestId: id } : {})
    })
  }
  return new ProviderRequestError(config.provider, code,
    code === 'http' ? `${config.provider} request failed (HTTP ${status})` : `Invalid ${config.provider} agent output: agent response was not completed`, status, details)
}

export const MAX_BODY_BYTES = 16_777_216
export const MAX_EVENT_CHARS = 1_048_576
const MAX_ERROR_BODY_BYTES = 65_536

/** Error classification is bounded and best-effort; malformed/large bodies remain HTTP errors. */
async function readHttpError(response: Response, context: RequestContext): Promise<unknown> {
  if (!response.body) return undefined
  const reader = response.body.getReader()
  const cancel = (): void => { void reader.cancel().catch(() => {}) }
  context.signal.addEventListener('abort', cancel, { once: true })
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let text = ''
    let bytes = 0
    while (true) {
      context.check()
      const next = await reader.read()
      context.check()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_ERROR_BODY_BYTES) return undefined
      text += decoder.decode(next.value, { stream: true })
    }
    text += decoder.decode()
    context.check()
    const value: unknown = JSON.parse(text)
    context.check()
    return value
  } catch {
    context.check()
    return undefined
  } finally {
    context.signal.removeEventListener('abort', cancel)
    cancel()
    try { reader.releaseLock() } catch { /* An abort-ignoring injected reader can remain pending. */ }
  }
}

async function bodyReader<T>(
  response: Response, context: RequestContext, provider: Provider,
  process: (value: Uint8Array) => Promise<T | undefined>
): Promise<T | undefined> {
  if (!response.body) throw new ProviderRequestError(provider, 'invalid_response', `${provider} response has no body`)
  const reader = response.body.getReader()
  const cancel = (): void => { void reader.cancel().catch(() => {}) }
  context.signal.addEventListener('abort', cancel, { once: true })
  let total = 0
  try {
    while (true) {
      context.check()
      const next = await reader.read()
      context.check()
      if (next.done) return undefined
      total += next.value.byteLength
      if (total > MAX_BODY_BYTES) {
        throw new ProviderRequestError(provider, 'invalid_response', `${provider} response exceeded the size limit`)
      }
      const terminal = await process(next.value)
      context.check()
      if (terminal !== undefined) return terminal
    }
  } finally {
    context.signal.removeEventListener('abort', cancel)
    cancel()
    try { reader.releaseLock() } catch { /* A cancelled injected reader can still be pending. */ }
  }
}

export async function readJson(response: Response, context: RequestContext, provider: Provider): Promise<unknown> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = ''
  await bodyReader(response, context, provider, async (bytes) => {
    text += decoder.decode(bytes, { stream: true })
    return undefined
  })
  text += decoder.decode()
  context.check()
  let value: unknown
  try { value = JSON.parse(text) as unknown } catch {
    context.check()
    throw new ProviderRequestError(provider, 'invalid_response', `${provider} response was not valid JSON`)
  }
  context.check()
  return value
}

export interface ServerEvent { event: string; data: string }

/** WHATWG SSE framing: UTF-8 fragments, CR/LF/CRLF, BOM, comments, and multiline data. */
export async function readSse<T>(
  response: Response, context: RequestContext, provider: Provider,
  onEvent: (event: ServerEvent) => Promise<T | undefined>
): Promise<T> {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
    throw new ProviderRequestError(provider, 'invalid_response', `${provider} streaming response was not event-stream`)
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let line = ''
  let event = ''
  let data = ''
  let hasData = false
  let precedingCR = false
  const processLine = async (): Promise<T | undefined> => {
    context.check()
    const value = line
    line = ''
    if (!value) {
      if (!hasData) { event = ''; return undefined }
      const frame = { event: event || 'message', data: data.slice(0, -1) }
      event = ''; data = ''; hasData = false
      const terminal = await onEvent(frame)
      context.check()
      return terminal
    }
    if (value.startsWith(':')) return undefined
    const colon = value.indexOf(':')
    const field = colon === -1 ? value : value.slice(0, colon)
    let payload = colon === -1 ? '' : value.slice(colon + 1)
    if (payload.startsWith(' ')) payload = payload.slice(1)
    if (field === 'data') { data += `${payload}\n`; hasData = true }
    else if (field === 'event') event = payload
    // id/retry are irrelevant to this single POST stream; no reconnect or retry occurs.
    if (data.length > MAX_EVENT_CHARS) {
      throw new ProviderRequestError(provider, 'invalid_response', `${provider} stream event exceeded the size limit`)
    }
    return undefined
  }
  const terminal = await bodyReader(response, context, provider, async (bytes) => {
    const text = decoder.decode(bytes, { stream: true })
    for (const char of text) {
      if (precedingCR && char === '\n') { precedingCR = false; continue }
      precedingCR = false
      if (char === '\r' || char === '\n') {
        precedingCR = char === '\r'
        const value = await processLine()
        if (value !== undefined) return value
      } else {
        line += char
        if (line.length > MAX_EVENT_CHARS) {
          throw new ProviderRequestError(provider, 'invalid_response', `${provider} stream line exceeded the size limit`)
        }
      }
    }
    return undefined
  })
  // SSE discards an unterminated frame at EOF. A provider must have sent its terminal frame.
  decoder.decode()
  context.check()
  if (terminal === undefined) {
    throw new ProviderRequestError(provider, 'invalid_response', `${provider} stream ended before completion`)
  }
  return terminal
}

export function eventJson(event: ServerEvent, provider: Provider): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(event.data) as unknown } catch {
    throw new ProviderRequestError(provider, 'invalid_response', `${provider} stream event was not valid JSON`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderRequestError(provider, 'invalid_response', `${provider} stream event must be an object`)
  }
  return value as Record<string, unknown>
}
