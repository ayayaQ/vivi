// SPDX-License-Identifier: Apache-2.0
import type { AgentError, AgentResult, HistoryMessage, Usage } from '../types.js'

export type AgentRecordData<T> = T extends object ? { readonly [K in keyof T]: AgentRecordData<T[K]> } : T

/** Host-owned immutable source reference; omission of a revision means it is unreported. */
export interface AgentRecordSource {
  readonly reference: string
  readonly revision?: string
}

export interface AgentHistoryEntry {
  readonly id: string
  readonly source: AgentRecordSource
  readonly message: AgentRecordData<HistoryMessage>
}

/** Exact host evidence, never inferred from a live event or generic tool result. */
export interface AgentOutcomeEvidence {
  readonly callId: string
  /** Original host run identity, or null when legacy evidence did not record one. */
  readonly runId: string | null
  readonly name: string
  readonly argumentsDigest: string
  readonly status: 'succeeded' | 'failed' | 'denied' | 'cancelled' | 'unknown'
  readonly effect: 'not_attempted' | 'confirmed' | 'unknown' | 'unreported'
  readonly source: AgentRecordSource
  /** Exact prior evidence digest when a host refines an unknown/unreported outcome. */
  readonly supersedes?: string
}

export interface AgentRecordSnapshot {
  readonly history: readonly AgentHistoryEntry[]
  readonly outcomes: readonly AgentOutcomeEvidence[]
  /** Authoritative session aggregate; replacement, not an increment. */
  readonly usage: Readonly<Usage>
}

export interface AgentRunSettlement {
  readonly status: AgentResult['status']
  readonly content: string
  readonly rounds: number
  readonly usage: Readonly<Usage>
  readonly error?: AgentError
}

export interface AgentRecordEnvelope {
  readonly version: 1
  readonly sessionId: string
  readonly eventId: string
  readonly sequence: number
  readonly previousEventId: string | null
  readonly source: AgentRecordSource
}

export type DurableAgentRecord = AgentRecordEnvelope & (
  | { readonly type: 'session_snapshot'; readonly reason: 'legacy_import' | 'privacy' | 'reconciliation'; readonly snapshot: AgentRecordSnapshot }
  | { readonly type: 'run_settled'; readonly runId: string; readonly inputHistoryLength: number; readonly settlement: AgentRunSettlement; readonly snapshot: AgentRecordSnapshot }
)

export interface AgentRecordReceipt {
  readonly eventId: string
  readonly sequence: number
  readonly digest: string
  readonly bytes: number
}

/** A consumer cursor, not evidence of filesystem commit or external delivery. */
export interface AgentProjection {
  readonly sessionId: string
  readonly sequence: number
  readonly eventId: string | null
  readonly history: readonly AgentHistoryEntry[]
  readonly outcomes: readonly AgentOutcomeEvidence[]
  readonly usage: Readonly<Usage>
  readonly runs: readonly { readonly runId: string; readonly status: AgentResult['status']; readonly rounds: number; readonly usage: Readonly<Usage>; readonly source: AgentRecordSource; readonly eventId: string }[]
  /** Hash-only duplicate bridges retain no superseded message contents. */
  readonly callBindings: readonly { readonly callId: string; readonly runId: string; readonly name: string; readonly argumentsDigest: string }[]
  readonly receipts: readonly AgentRecordReceipt[]
}

export interface CreateRunSettlementOptions {
  readonly envelope: AgentRecordEnvelope
  readonly runId: string
  /** Length of the canonical input prefix, excluding transient host context. */
  readonly inputHistoryLength: number
  /** Final host-reconciled result, after its admitted outcome work has drained. */
  readonly result: AgentResult
  readonly history: readonly AgentHistoryEntry[]
  readonly outcomes: readonly AgentOutcomeEvidence[]
  readonly sessionUsage: Usage
}
