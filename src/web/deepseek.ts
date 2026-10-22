// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import { WebProviderError } from '../web.js'
import type {
  WebFetchResponse, WebProvenance, WebProvider, WebProviderErrorCode, WebRequestIntent, WebRequestState,
  WebSearchResponse, WebSearchResult, WebSearchTextField
} from '../web.js'

/** Trusted host configuration. There is deliberately no configurable provider URL or model. */
export interface DeepSeekWebProviderOptions {
  apiKey: string | (() => string | Promise<string>)
  /** Offline transport injection. The host must not expose this option to model arguments. */
  fetch?: typeof fetch
  /** Await durable intent and recheck host policy before dispatch. Throw to prevent transport. */
  beforeRequest?: (intent: WebRequestIntent, signal: AbortSignal) => void | Promise<void>
  /** End-to-end deadline, including credential resolution and body reads. Default 60,000 ms. */
  timeoutMs?: number
  /** UTF-8 response cap, default 2 MiB, maximum 16 MiB. Oversize responses fail closed. */
  maxResponseBytes?: number
  /** Local content bound in Unicode code points, default 100,000, maximum 1,000,000. */
  maxContentChars?: number
}

const PROVIDER = 'deepseek'
const API_ROOT = 'https://api.deepseek.com/v1/tools/'
const TITLE_CHARS = 2_048
const SNIPPET_CHARS = 4_096
const SUMMARY_CHARS = 8_192

function error(code: WebProviderErrorCode, state: WebRequestState = 'not_started', status?: number): WebProviderError {
  const messages: Record<WebProviderErrorCode, string> = {
    configuration: 'DeepSeek web provider configuration is invalid',
    invalid_request: 'DeepSeek web request is invalid',
    preflight: 'DeepSeek web request was stopped before dispatch',
    http: 'DeepSeek web API returned an unsuccessful HTTP status',
    transport: 'DeepSeek web request failed',
    invalid_response: 'DeepSeek web API returned an invalid response',
    response_too_large: 'DeepSeek web API response exceeded the byte limit',
    timeout: 'DeepSeek web request timed out',
    aborted: 'DeepSeek web request was aborted'
  }
  return new WebProviderError(PROVIDER, code, messages[code], state, status)
}

function integer(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw error('configuration')
  }
  return value
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Count Unicode code points, not UTF-16 units, and stop as soon as the bound is exceeded. */
function within(value: string, maximum: number): boolean {
  let count = 0
  for (const _ of value) if (++count > maximum) return false
  return true
}

function validUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value !== value.trim() || !within(value, 8_192)) return false
  // URL() otherwise silently strips embedded controls or repairs backslashes/invalid prefixes.
  if (!/^https?:\/\//i.test(value) || /^https?:\/\/[^/?#]*@/i.test(value) || /[\u0000-\u0020\u007f\\]/u.test(value)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname && !url.username && !url.password
  } catch { return false }
}

function text(value: unknown, maximum: number, field: string, truncated: string[], request: RequestContext): string {
  if (typeof value !== 'string') throw request.fail('invalid_response')
  let count = 0
  let end = 0
  for (const character of value) {
    if (count++ === maximum) { truncated.push(field); return value.slice(0, end) }
    end += character.length
  }
  return value
}

function provenance(operation: 'search' | 'fetch'): WebProvenance {
  return { provider: PROVIDER, operation, retrievedAt: new Date().toISOString(), untrusted: true, upstreamTruncation: 'unknown' }
}

interface RequestContext {
  signal: AbortSignal
  state: WebRequestState
  fail(code: WebProviderErrorCode, status?: number): WebProviderError
  owns(caught: unknown): boolean
  check(): void
  wait<T>(operation: Promise<T>): Promise<T>
  close(): void
}

function context(timeoutMs: number, parent?: AbortSignal): RequestContext {
  const controller = new AbortController()
  const deadline = performance.now() + timeoutMs
  let stopped: 'aborted' | 'timeout' | undefined
  const internalErrors = new WeakSet<WebProviderError>()
  let rejectStop: (reason: unknown) => void = () => {}
  const stopPromise = new Promise<never>((_, reject) => { rejectStop = reject })
  // An already-aborted signal may reject before the first operation is awaited.
  void stopPromise.catch(() => {})
  const result: RequestContext = {
    signal: controller.signal, state: 'not_started',
    fail(code, status) {
      const failure = error(code, result.state, status)
      internalErrors.add(failure)
      return failure
    },
    owns(caught) { return caught instanceof WebProviderError && internalErrors.has(caught) },
    check() {
      if (!stopped && performance.now() >= deadline) stop('timeout')
      if (stopped) throw result.fail(stopped)
    },
    async wait<T>(operation: Promise<T>): Promise<T> {
      result.check()
      const value = await Promise.race([operation, stopPromise])
      result.check()
      return value
    },
    close() { clearTimeout(timer); parent?.removeEventListener('abort', abort) }
  }
  function stop(code: 'aborted' | 'timeout'): void {
    if (stopped) return
    stopped = code
    controller.abort()
    rejectStop(result.fail(code))
  }
  const abort = (): void => { stop('aborted') }
  const timer = setTimeout(() => { stop('timeout') }, timeoutMs)
  parent?.addEventListener('abort', abort, { once: true })
  if (parent?.aborted) abort()
  return result
}

function cancel(response: Response): void {
  try { void response.body?.cancel().catch(() => {}) } catch { /* Sanitized best-effort cleanup. */ }
}

async function readJson(response: Response, request: RequestContext, maximum: number): Promise<unknown> {
  if (!response.body) throw request.fail('invalid_response')
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximum) {
    cancel(response)
    throw request.fail('response_too_large')
  }
  const reader = response.body.getReader()
  const stopReader = (): void => { void reader.cancel().catch(() => {}) }
  request.signal.addEventListener('abort', stopReader, { once: true })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let total = 0
  let content = ''
  try {
    while (true) {
      request.check()
      const next = await request.wait(reader.read())
      if (next.done) break
      total += next.value.byteLength
      if (total > maximum) throw request.fail('response_too_large')
      content += decoder.decode(next.value, { stream: true })
    }
    content += decoder.decode()
    request.check()
    const value: unknown = JSON.parse(content)
    request.check()
    return value
  } catch (caught) {
    request.check()
    if (request.owns(caught)) throw caught
    throw request.fail('invalid_response')
  } finally {
    request.signal.removeEventListener('abort', stopReader)
    stopReader()
    try { reader.releaseLock() } catch { /* An injected reader may ignore cancellation. */ }
  }
}

/** One paid provider request per call. No retries, fallback, target-page HTTP client, or browser. */
export function createDeepSeekWebProvider(options: DeepSeekWebProviderOptions): WebProvider {
  if (!record(options) || (typeof options.apiKey !== 'string' && typeof options.apiKey !== 'function')) {
    throw error('configuration')
  }
  const keySource = options.apiKey
  if (typeof keySource === 'string' && (!keySource.trim() || /[\r\n]/.test(keySource))) throw error('configuration')
  const transport = options.fetch ?? globalThis.fetch
  if (typeof transport !== 'function') throw error('configuration')
  const beforeRequest = options.beforeRequest
  if (beforeRequest !== undefined && typeof beforeRequest !== 'function') throw error('configuration')
  const timeoutMs = integer(options.timeoutMs, 60_000, 2_147_483_647)
  const maximumBytes = integer(options.maxResponseBytes, 2_097_152, 16_777_216)
  const maximumContent = integer(options.maxContentChars, 100_000, 1_000_000)

  async function request<T>(intent: WebRequestIntent, body: Record<string, unknown>, signal: AbortSignal | undefined,
    normalize: (value: unknown, request: RequestContext) => T): Promise<T> {
    const current = context(timeoutMs, signal)
    let preflight = false
    try {
      current.check()
      const key = await current.wait(Promise.resolve().then(() => typeof keySource === 'function' ? keySource() : keySource))
      if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) throw error('configuration')
      if (beforeRequest) {
        preflight = true
        await current.wait(Promise.resolve().then(() => { current.check(); return beforeRequest(intent, current.signal) }))
        preflight = false
      }
      current.check()
      current.state = 'unknown'
      const pending = Promise.resolve(transport(API_ROOT + intent.operation, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: current.signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer'
      }))
      // Dispose of a late response if an injected transport ignores abort.
      void pending.then(response => { if (current.signal.aborted) cancel(response) }, () => {})
      const response = await current.wait(pending)
      current.state = 'response_received'
      const status = response.status
      if (!Number.isInteger(status) || status < 100 || status > 599) { cancel(response); throw current.fail('invalid_response') }
      if (status !== 200) { cancel(response); throw current.fail('http', status) }
      const value = await readJson(response, current, maximumBytes)
      const normalized = normalize(value, current)
      current.check()
      return normalized
    } catch (caught) {
      current.check()
      if (current.state === 'not_started') throw error(preflight ? 'preflight' : 'configuration')
      if (current.owns(caught)) throw caught
      throw current.fail('transport')
    } finally { current.close() }
  }

  return {
    id: PROVIDER,
    async search(input, signal): Promise<WebSearchResponse> {
      if (!record(input)) throw error('invalid_request')
      const { query, count: requestedCount, includeContent: requestedContent } = input
      if (typeof query !== 'string' || !query.trim() || !within(query, 128) ||
        (requestedCount !== undefined && (!Number.isSafeInteger(requestedCount) || (requestedCount as number) < 1 || (requestedCount as number) > 50)) ||
        (requestedContent !== undefined && typeof requestedContent !== 'boolean')) throw error('invalid_request')
      const count = (requestedCount as number | undefined) ?? 10
      const includeContent = (requestedContent as boolean | undefined) ?? false
      const intent = Object.freeze({ provider: PROVIDER, operation: 'search' as const,
        request: Object.freeze({ query, count, includeContent }) })
      return request(intent, { query, count, need_content: includeContent }, signal, (value, current) => {
        if (!record(value) || !Array.isArray(value.results)) throw current.fail('invalid_response')
        const results: WebSearchResult[] = value.results.slice(0, count).map((item: unknown) => {
          if (!record(item) || !validUrl(item.url)) throw current.fail('invalid_response')
          const localTruncation: WebSearchTextField[] = []
          return {
            title: text(item.title, TITLE_CHARS, 'title', localTruncation, current), url: item.url,
            snippet: text(item.snippet, SNIPPET_CHARS, 'snippet', localTruncation, current),
            summary: text(item.summary, SUMMARY_CHARS, 'summary', localTruncation, current),
            content: text(item.content, maximumContent, 'content', localTruncation, current), localTruncation
          }
        })
        return { results, resultLimitApplied: value.results.length > count, provenance: provenance('search') }
      })
    },
    async fetch(input, signal): Promise<WebFetchResponse> {
      if (!record(input)) throw error('invalid_request')
      const requestedUrl = input.url
      if (!validUrl(requestedUrl)) throw error('invalid_request')
      const intent = Object.freeze({ provider: PROVIDER, operation: 'fetch' as const, request: Object.freeze({ url: requestedUrl }) })
      return request(intent, { url: requestedUrl }, signal, (value, current) => {
        if (!record(value)) throw current.fail('invalid_response')
        const localTruncation: ('title' | 'contentMarkdown')[] = []
        return { requestedUrl, title: text(value.title, TITLE_CHARS, 'title', localTruncation, current),
          contentMarkdown: text(value.content, maximumContent, 'contentMarkdown', localTruncation, current),
          localTruncation, provenance: provenance('fetch') }
      })
    }
  }
}
