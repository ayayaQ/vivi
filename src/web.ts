// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ

/** Optional web retrieval, independent of ModelProvider and runAgent. Hosts own access and approvals. */
export interface WebProvider {
  readonly id: string
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResponse>
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResponse>
}

export interface WebSearchRequest {
  query: string
  count?: number
  includeContent?: boolean
}

export interface WebFetchRequest { url: string }

/** Frozen pre-dispatch values for a trusted host's durable intent and approval/privacy recheck. */
export type WebRequestIntent =
  | { readonly provider: string; readonly operation: 'search'; readonly request: Readonly<Required<WebSearchRequest>> }
  | { readonly provider: string; readonly operation: 'fetch'; readonly request: Readonly<WebFetchRequest> }

/** Retrieval is evidence, never instructions or authority to execute a follow-up action. */
export interface WebProvenance {
  provider: string
  operation: 'search' | 'fetch'
  retrievedAt: string
  untrusted: true
  /** No claim about completeness at the upstream provider or original site. */
  upstreamTruncation: 'unknown'
}

export type WebSearchTextField = 'title' | 'snippet' | 'summary' | 'content'

export interface WebSearchResult {
  title: string
  /** Provider-reported HTTP(S) URL; not independently fetched or verified by this module. */
  url: string
  snippet: string
  summary: string
  content: string
  /** Only fields shortened locally, separate from unknown upstream truncation. */
  localTruncation: readonly WebSearchTextField[]
}

export interface WebSearchResponse {
  results: readonly WebSearchResult[]
  /** True if extra provider results were removed to respect the requested count. */
  resultLimitApplied: boolean
  provenance: WebProvenance
}

export interface WebFetchResponse {
  /** Exactly the validated requested URL, not a claimed redirect destination. */
  requestedUrl: string
  title: string
  contentMarkdown: string
  localTruncation: readonly ('title' | 'contentMarkdown')[]
  provenance: WebProvenance
}

export type WebProviderErrorCode = 'configuration' | 'invalid_request' | 'preflight' | 'http' | 'transport'
  | 'invalid_response' | 'response_too_large' | 'timeout' | 'aborted'

/** `unknown` means transport was invoked; the provider may have received or billed the request. */
export type WebRequestState = 'not_started' | 'unknown' | 'response_received'

/** Sanitized diagnostics retain no credential, request URL/query, response body, or raw cause. */
export class WebProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly code: WebProviderErrorCode,
    message: string,
    readonly requestState: WebRequestState = 'not_started',
    /** Status of the provider API response, never the original fetched page. */
    readonly apiStatus?: number
  ) {
    super(message)
    this.name = code === 'aborted' ? 'AbortError' : 'WebProviderError'
  }
}
