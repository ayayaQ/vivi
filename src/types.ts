// SPDX-License-Identifier: Apache-2.0
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

export interface ModelProvider {
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
  /** Awaited in order. Providers must not call this after generation settles. */
  onProgress?(event: ProviderProgress): void | Promise<void>
}

export interface ToolResult {
  content: string
  isError?: boolean
}

export type AgentEvent =
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
  message: string
}

export interface AgentResult {
  status: 'completed' | 'cancelled' | 'error'
  history: HistoryMessage[]
  content: string
  rounds: number
  /** Sums committed rounds. Each cache count is included only if every such round reports it. */
  usage: Usage
  error?: AgentError
}
