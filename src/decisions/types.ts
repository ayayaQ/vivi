// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import type { JsonObject, JsonValue } from '../types.js'

export type DecisionProviderId = 'openai' | 'openrouter'
export type DecisionOutcome = 'allow' | 'ask' | 'deny'
export interface ReadonlyJsonObject { readonly [key: string]: ReadonlyJson }
export type ReadonlyJson = null | string | number | boolean |
  readonly ReadonlyJson[] | ReadonlyJsonObject

/** Resolved and classified by trusted host code, never by the acting or review model. */
export interface PreparedActionEffect {
  readonly kind: 'read' | 'write' | 'external' | 'unknown'
  /** Literal host-resolved identity, also a key in resourceRevisions; not a path policy. */
  readonly resourceId: string
  readonly scope: 'workspace' | 'outside-workspace' | 'external' | 'unknown'
  /** Exact affected content/selection or host-prepared before/after evidence. Data, not instructions. */
  readonly affectedData: ReadonlyJson
  /** ordinary-read requires a permitted, non-sensitive workspace read; model-review requires host eligibility. */
  readonly review: 'ordinary-read' | 'model-review' | 'manual' | 'blocked'
}

export interface PreparedActionMetadata {
  /** False when preparation cannot account for every effect and affected resource. */
  readonly complete: boolean
  readonly effects: readonly PreparedActionEffect[]
}

/** Routing only. No route grants access, permits provider transmission, or authorizes execution. */
export interface PreparedActionRoute {
  readonly route: 'auto-read' | 'model-review' | 'manual' | 'blocked'
  readonly reasonCode: 'ordinary_workspace_read' | 'model_review_required' | 'host_manual' | 'host_blocked' |
    'missing_metadata' | 'incomplete_effects' | 'unknown_effects' | 'invalid_classification' | 'invalid_snapshot'
}

/** Host-owned identity and revisions; inputData and tool arguments are evidence, not instructions. */
export interface DecisionSnapshot {
  sessionId: string
  runId: string
  toolCall: { id: string; name: string; arguments: JsonObject }
  userRequest: { id: string; text: string; approvedScope: JsonValue }
  policyRevision: string
  resourceRevisions: JsonObject
  inputData: JsonValue
  /** Optional prepared effects; existing callers without metadata retain their review behavior. */
  preparedAction?: PreparedActionMetadata
}

/** Every check is a requirement. Questions and thresholds must be authored by the host. */
export interface DecisionCheck {
  name: string
  instructions: string
  trueDescription: string
  falseDescription: string
  /** Provider-specific calibration is required; no shared/default approval threshold exists. */
  allowAt: number
  /** Optional model recommendation to reject; this is never a hard-policy rejection. */
  denyAt?: number
}

export interface DecisionPolicy {
  provider: DecisionProviderId
  checks: readonly DecisionCheck[]
}

/** Created by createDecisionRequest, copied and deeply frozen before any asynchronous work. */
export interface DecisionRequest {
  readonly snapshot: {
    readonly sessionId: string
    readonly runId: string
    readonly toolCall: { readonly id: string; readonly name: string; readonly arguments: ReadonlyJsonObject }
    readonly userRequest: { readonly id: string; readonly text: string; readonly approvedScope: ReadonlyJson }
    readonly policyRevision: string
    readonly resourceRevisions: ReadonlyJsonObject
    readonly inputData: ReadonlyJson
    readonly preparedAction?: PreparedActionMetadata
  }
  readonly policy: { readonly provider: DecisionProviderId; readonly checks: readonly Readonly<DecisionCheck>[] }
}

export interface DecisionUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cachedTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  readonly costUsd?: number
}

export type DecisionAnswer =
  | { readonly name: string; readonly type: 'predicate'; readonly probability: number }
  | { readonly name: string; readonly type: 'refusal' }

/** A provider evaluates evidence only. It receives no executor or permission-grant callback. */
export interface DecisionProvider {
  readonly id: DecisionProviderId
  readonly model: string
  evaluate(request: DecisionRequest, signal: AbortSignal): Promise<{
    readonly model: string
    readonly answers: readonly DecisionAnswer[]
    readonly usage: DecisionUsage
  }>
}

export type DecisionReasonCode = 'requirements_met' | 'provider_recommended_reject' | 'uncertain' |
  'refusal' | 'invalid_request' | 'invalid_response' | 'unsupported_model' | 'provider_mismatch' |
  'configuration' | 'http' | 'rate_limit' | 'transport' | 'timeout' | 'aborted'

export interface DecisionCheckResult {
  readonly name: string
  readonly probability: number
  readonly reasonCode: 'allow_threshold_met' | 'deny_threshold_met' | 'between_thresholds'
}

/** Recommendation, never execution authority. Only coded reasons and normalized usage are returned. */
export interface DecisionResult {
  readonly outcome: DecisionOutcome
  readonly reasonCode: DecisionReasonCode
  readonly checks: readonly DecisionCheckResult[]
  readonly provider?: DecisionProviderId
  readonly model?: string
  readonly usage?: DecisionUsage
  readonly httpStatus?: number
}

export interface EvaluateDecisionOptions {
  signal?: AbortSignal
  /** End-to-end deadline including custom providers; default 10 seconds. */
  timeoutMs?: number
}

/** Credentials remain host-owned. The fixed official endpoint cannot be changed by request data. */
export interface DecisionProviderOptions {
  apiKey: string | (() => string | Promise<string>)
  timeoutMs?: number
  /** Offline transport injection. No retries or cross-provider fallbacks are performed. */
  fetch?: typeof fetch
}
