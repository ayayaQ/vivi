// SPDX-License-Identifier: Apache-2.0
import type { AgentAcceptedUpdate, Usage } from '../types.js'
import type { AgentHistoryEntry, AgentProjection, AgentRecordSource, DurableAgentRecord } from './types.js'

/** Order is local to one run. Session terminal records retain their separate session order. */
export interface AgentRunRecordEnvelope {
  readonly version: 1
  readonly scope: 'run'
  readonly sessionId: string
  readonly runId: string
  readonly eventId: string
  readonly sequence: number
  readonly previousEventId: string | null
  readonly source: AgentRecordSource
}

export type AgentRunRecord = AgentRunRecordEnvelope & (
  | { readonly type: 'run_started'; readonly baseSequence: number; readonly baseEventId: string | null;
      readonly baseReceiptDigest: string | null; readonly input: readonly AgentHistoryEntry[] }
  | { readonly type: 'assistant_accepted'; readonly entry: AgentHistoryEntry; readonly round: number;
      readonly usage?: Readonly<Usage>; readonly aggregateUsage: Readonly<Usage> }
  | { readonly type: 'tool_result_accepted'; readonly entry: AgentHistoryEntry; readonly round: number }
  | { readonly type: 'run_settled'; readonly terminal: DurableAgentRecord }
)

export interface AgentRunProjection {
  readonly sessionId: string
  readonly runId: string
  readonly sequence: number
  readonly eventId: string | null
  readonly state: 'waiting' | 'running' | 'settled'
  readonly baseSequence: number
  readonly baseEventId: string | null
  readonly baseReceiptDigest: string | null
  readonly inputHistoryLength: number
  readonly history: readonly AgentHistoryEntry[]
  /** Exact observed accepted-round counts. Running state is not a final usage total. */
  readonly rounds: number
  readonly runUsage: Readonly<Usage>
  readonly session: AgentProjection
  readonly receipts: readonly { readonly eventId: string; readonly sequence: number; readonly digest: string; readonly bytes: number }[]
}

export interface CreateAgentAcceptedRecordOptions {
  readonly envelope: AgentRunRecordEnvelope
  readonly update: AgentAcceptedUpdate
  readonly historyId: string
  readonly source: AgentRecordSource
}
