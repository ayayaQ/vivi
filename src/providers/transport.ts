// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import type { JsonObject } from '../types.js'
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
}

export interface ProgressOptions {
  onProgress?(event: { type: 'text_delta'; text: string }): void | Promise<void>
}

/** Sanitized errors never retain raw response bodies, credential values, URLs, or causes. */
export class ProviderRequestError extends Error {
  constructor(
    readonly provider: Provider,
    readonly code: 'configuration' | 'http' | 'transport' | 'invalid_response' | 'timeout' | 'aborted',
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = code === 'aborted' ? 'AbortError' : 'ProviderRequestError'
  }
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
    stream: options.stream ?? false, endpoint: endpoint!, fetch: fetchImpl,
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
    if (response.body) void response.body.cancel().catch(() => {})
    throw new ProviderRequestError(config.provider, 'http',
      `${config.provider} request failed (HTTP ${response.status})`, response.status)
  }
  return response
}

export const MAX_BODY_BYTES = 16_777_216
export const MAX_EVENT_CHARS = 1_048_576

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
