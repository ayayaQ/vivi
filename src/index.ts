// SPDX-License-Identifier: Apache-2.0
export { runAgent } from './run-agent.js'
export { closeInterruptedHistory, validateHistory } from './history.js'
export type {
  AgentAcceptedUpdate,
  AgentError,
  AgentEvent,
  AgentResult,
  AssistantMessage,
  HistoryMessage,
  JsonObject,
  JsonValue,
  Message,
  ModelProvider,
  ContextEstimate,
  ProviderResult,
  ProviderGenerateOptions,
  ProviderProgress,
  ProviderState,
  RunAgentOptions,
  ToolCall,
  ToolDefinition,
  ToolResult,
  ToolResultMessage,
  Usage
} from './types.js'

export { prepareContext, compactContext, measureContext, estimateContext, validateContextCheckpoint, ContextError } from './context.js'
export type { ContextCheckpoint, ContextOptions, ContextLimits, ContextLimitSource, ContextUsage, ContextInput, PreparedContext, ContextEvent, CompactionReason } from './context.js'
