// SPDX-License-Identifier: Apache-2.0
import type { ContextCheckpoint, ContextOptions, ContextUsage, ContextEvent } from './context.js'
/** Values that adapters can persist without application-specific serialization. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export interface JsonObject {
  [key: string]: JsonValue
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonObject
}

export interface ToolCall {
  id: string
  name: string
  arguments: JsonObject
}

/** Opaque native assistant items. Only the named provider adapter should interpret them. */
export interface ProviderState {
  provider: string
  items: JsonValue[]
}

export interface Message {
  kind: 'message'
  role: 'user' | 'system'
  content: string
}

export interface AssistantMessage {
  kind: 'assistant'
  content: string
  toolCalls: ToolCall[]
  providerState?: ProviderState
}

export interface ToolResultMessage {
  kind: 'tool_result'
  callId: string
  name: string
  content: string
  isError?: boolean
}

export type HistoryMessage = Message | AssistantMessage | ToolResultMessage

export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** Input tokens read from cache, already included in inputTokens; omitted when unreported. */
  cachedInputTokens?: number
  /** Input tokens written to cache, already included in inputTokens; omitted when unreported. */
  cacheWriteInputTokens?: number
}

export interface ProviderResult {
  content: string
  toolCalls: ToolCall[]
  usage?: Usage
  providerState?: ProviderState
}

export interface ContextEstimate {
  inputTokens: number
  /** False only for a provider/tokenizer measurement of this entire effective request. */
  estimated: boolean
}

export interface ModelProvider {
  /** Pure effective-request measurement; must apply the same projection as generate. */
  estimateContext?(
    input: { messages: readonly HistoryMessage[]; tools: readonly ToolDefinition[] },
    options?: { maxOutputTokens?: number }
  ): ContextEstimate
  generate(
    input: { messages: readonly HistoryMessage[]; tools: readonly ToolDefinition[] },
    signal: AbortSignal,
    options?: ProviderGenerateOptions
  ): Promise<ProviderResult>
}

/** Display-only provider progress. It is never a committed assistant message. */
export interface ProviderProgress {
  type: 'text_delta'
  text: string
}

export interface ProviderGenerateOptions {
  /** Host metadata only. Summary requests never represent a canonical accepted assistant round. */
  purpose?: 'response' | 'context-summary'
  /** Host-only canonical call IDs reserved outside a compacted view. Never part of the model prompt. */
  reservedToolCallIds?: readonly string[]
  /** Explicit request output bound, including any reasoning tokens where supported. */
  maxOutputTokens?: number
  /** Awaited in order. Providers must not call this after generation settles. */
  onProgress?(event: ProviderProgress): void | Promise<void>
}

export interface ToolResult {
  content: string
  isError?: boolean
}

export type AgentEvent =
  | ContextEvent
  | ProviderProgress
  | { type: 'assistant'; message: AssistantMessage }
  | { type: 'tool_started'; call: ToolCall }
  | { type: 'tool_completed'; message: ToolResultMessage }
  | { type: 'round_completed'; usage?: Usage }

/** Canonical acceptance, separate from transient progress and host storage acknowledgement. */
export type AgentAcceptedUpdate =
  | { type: 'assistant_accepted'; message: AssistantMessage; round: number; usage?: Usage; aggregateUsage: Usage }
  | { type: 'tool_result_accepted'; message: ToolResultMessage; round: number }

export interface RunAgentOptions {
  /** Opt-in provider-facing context management. Canonical messages are never replaced. */
  context?: ContextOptions
  provider: ModelProvider
  messages: readonly HistoryMessage[]
  tools: readonly ToolDefinition[]
  executeTool(call: ToolCall, context: { signal: AbortSignal }): Promise<ToolResult>
  signal?: AbortSignal
  /** Maximum provider rounds, including a final text-only response. Integer 1..1000, default 25. */
  maxRounds?: number
  /** Awaited in order. Receives deeply frozen copies, never the live transcript. */
  onEvent?(event: AgentEvent): void | Promise<void>
  /** Opt-in frozen canonical updates, after acceptance and before onEvent/next dispatch.
   * Awaited in order; failure is event_error. Hosts own durable commit and admitted-write drain.
   * Cleanup closures are in final AgentResult, not additional callbacks. */
  onAccepted?(update: AgentAcceptedUpdate): void | Promise<void>
}

export interface AgentError {
  code:
    | 'invalid_input'
    | 'invalid_provider_output'
    | 'provider_error'
    | 'event_error'
    | 'max_rounds'
    | 'context_error'
    | 'context_cannot_fit'
  message: string
}

export interface AgentResult {
  /** Last prepared dispatch snapshot; remeasure for next-request occupancy after completion. */
  contextUsage?: ContextUsage
  /** Latest prepared checkpoint. Omission is no update, never an instruction to delete a host checkpoint. */
  checkpoint?: ContextCheckpoint
  status: 'completed' | 'cancelled' | 'error'
  history: HistoryMessage[]
  content: string
  rounds: number
  /** Sum of reported committed-round usage, not occupancy or guaranteed complete billing.
   * A round without usage contributes no known count. Cache counts require every round to report them. */
  usage: Usage
  error?: AgentError
}
