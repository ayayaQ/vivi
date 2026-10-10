// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto'
import type { Usage } from '../types.js'
import { assertHistory } from '../validation.js'
import { assertEventJson, captureEventArray, eventObject, eventText } from './data.js'
import type {
  AgentProjection, AgentRecordSource, AgentRunSettlement, CreateRunSettlementOptions,
  DurableAgentRecord, AgentOutcomeEvidence, AgentRecordSnapshot
} from './types.js'

export const AGENT_RECORD_LIMITS = Object.freeze({
  bytes: 1024 * 1024, nodes: 65536, depth: 32, history: 4096,
  outcomes: 2048, records: 2048, identity: 256, reference: 2048,
  journalBytes: 64 * 1024 * 1024, projectionBytes: 8 * 1024 * 1024
})
const projections = new WeakSet<object>()
const digestPattern = /^[a-f0-9]{64}$/

function assertRecord(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function keys(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  assertRecord(eventObject(value), 'Record fields must be plain JSON objects')
  assertRecord(required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key)), 'Invalid or unsupported record fields')
}

function identity(value: unknown): asserts value is string {
  assertRecord(eventText(value, AGENT_RECORD_LIMITS.identity) && value === value.trim(), 'Invalid record identity')
}

function source(value: unknown): asserts value is AgentRecordSource {
  keys(value, ['reference'], ['revision'])
  assertRecord(eventText(value.reference, AGENT_RECORD_LIMITS.reference), 'Invalid source reference')
  if ('revision' in value) identity(value.revision)
}

function usage(value: unknown): asserts value is Usage {
  keys(value, ['inputTokens', 'outputTokens', 'totalTokens'], ['cachedInputTokens', 'cacheWriteInputTokens'])
  for (const count of Object.values(value)) assertRecord(Number.isSafeInteger(count) && (count as number) >= 0, 'Invalid usage count')
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function canonical(value: unknown): unknown {
  return Array.isArray(value) ? value.map(canonical) : eventObject(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function same(left: unknown, right: unknown): boolean {
  return digest(left) === digest(right)
}

/** Exact canonical argument binding for host ledger adapters, not proof of permission. */
export function agentArgumentsDigest(value: unknown): string {
  assertEventJson(value, AGENT_RECORD_LIMITS.bytes, { nodes: AGENT_RECORD_LIMITS.nodes, depth: AGENT_RECORD_LIMITS.depth })
  assertRecord(eventObject(value), 'Arguments must be a JSON object')
  return digest(value)
}

/** Bind a later evidence refinement to its exact prior record. */
export function agentEvidenceDigest(value: AgentOutcomeEvidence): string {
  assertEventJson(value, AGENT_RECORD_LIMITS.bytes, { nodes: AGENT_RECORD_LIMITS.nodes, depth: AGENT_RECORD_LIMITS.depth })
  return digest(value)
}

function settlement(value: unknown): asserts value is AgentRunSettlement {
  keys(value, ['status', 'content', 'rounds', 'usage'], ['error'])
  assertRecord(['completed', 'cancelled', 'error'].includes(value.status as string), 'Invalid run status')
  assertRecord(typeof value.content === 'string', 'Invalid settlement content')
  assertRecord(Number.isSafeInteger(value.rounds) && (value.rounds as number) >= 0 && (value.rounds as number) <= 1000, 'Invalid settled round count')
  usage(value.usage)
  if ('error' in value) {
    keys(value.error, ['code', 'message'])
    assertRecord(['invalid_input', 'invalid_provider_output', 'provider_error', 'event_error', 'max_rounds'].includes(value.error.code as string) &&
      typeof value.error.message === 'string', 'Invalid settled error')
  }
  assertRecord((value.status === 'error') === ('error' in value), 'Settlement error must match run status')
}

function snapshot(value: unknown): asserts value is AgentRecordSnapshot {
  keys(value, ['history', 'outcomes', 'usage'])
  assertRecord(Array.isArray(value.history) && value.history.length <= AGENT_RECORD_LIMITS.history, 'History limit exceeded')
  const messageIds = new Set<string>()
  for (const entry of value.history) {
    keys(entry, ['id', 'source', 'message'])
    identity(entry.id); source(entry.source)
    assertRecord(!messageIds.has(entry.id), 'Duplicate history identity'); messageIds.add(entry.id)
    const message = entry.message
    assertRecord(eventObject(message), 'Invalid history message')
    if (message.kind === 'message') keys(message, ['kind', 'role', 'content'])
    else if (message.kind === 'assistant') {
      keys(message, ['kind', 'content', 'toolCalls'], ['providerState'])
      assertRecord(Array.isArray(message.toolCalls), 'Invalid tool calls')
      for (const call of message.toolCalls) { keys(call, ['id', 'name', 'arguments']); identity(call.id); identity(call.name) }
      if ('providerState' in message) { keys(message.providerState, ['provider', 'items']); identity(message.providerState.provider) }
    } else keys(message, ['kind', 'callId', 'name', 'content'], ['isError'])
  }
  assertHistory(value.history.map(entry => entry.message))
  assertRecord(Array.isArray(value.outcomes) && value.outcomes.length <= AGENT_RECORD_LIMITS.outcomes, 'Outcome limit exceeded')
  const calls = value.history.flatMap(entry => entry.message.kind === 'assistant' ? entry.message.toolCalls : [])
  const outcomeIds = new Set<string>()
  for (const outcome of value.outcomes) {
    keys(outcome, ['callId', 'runId', 'name', 'argumentsDigest', 'status', 'effect', 'source'], ['supersedes'])
    identity(outcome.callId); identity(outcome.name); source(outcome.source)
    if (outcome.runId !== null) identity(outcome.runId)
    assertRecord(typeof outcome.argumentsDigest === 'string' && digestPattern.test(outcome.argumentsDigest), 'Invalid argument digest')
    assertRecord(['succeeded', 'failed', 'denied', 'cancelled', 'unknown'].includes(outcome.status as string), 'Invalid outcome status')
    assertRecord(['not_attempted', 'confirmed', 'unknown', 'unreported'].includes(outcome.effect as string), 'Invalid effect evidence')
    if ('supersedes' in outcome) assertRecord(typeof outcome.supersedes === 'string' && digestPattern.test(outcome.supersedes), 'Invalid prior evidence digest')
    assertRecord(!outcomeIds.has(outcome.callId), 'Duplicate outcome identity'); outcomeIds.add(outcome.callId)
    assertRecord(calls.some(call => call.id === outcome.callId && call.name === outcome.name), 'Outcome has no exact historical call')
    assertRecord(!(outcome.effect === 'not_attempted' && outcome.status === 'succeeded'), 'Not-attempted call cannot be successful')
  }
  usage(value.usage)
}

/** Decode bounded v1 records. Reject unknown fields; never fall back to an empty history. */
export function decodeAgentRecord(input: unknown): DurableAgentRecord {
  assertEventJson(input, AGENT_RECORD_LIMITS.bytes, { nodes: AGENT_RECORD_LIMITS.nodes, depth: AGENT_RECORD_LIMITS.depth })
  assertRecord(eventObject(input) && input.version === 1, 'Unsupported agent record version')
  const envelope = ['version', 'sessionId', 'eventId', 'sequence', 'previousEventId', 'source', 'type', 'snapshot']
  if (input.type === 'session_snapshot') {
    keys(input, [...envelope, 'reason'])
    assertRecord(['legacy_import', 'privacy', 'reconciliation'].includes(input.reason as string), 'Unsupported snapshot reason')
  } else {
    assertRecord(input.type === 'run_settled', 'Unsupported agent record type')
    keys(input, [...envelope, 'runId', 'inputHistoryLength', 'settlement']); identity(input.runId); settlement(input.settlement)
  }
  identity(input.sessionId); identity(input.eventId); source(input.source)
  assertRecord(Number.isSafeInteger(input.sequence) && (input.sequence as number) >= 1 && (input.sequence as number) <= AGENT_RECORD_LIMITS.records, 'Invalid record sequence')
  if (input.previousEventId !== null) identity(input.previousEventId)
  assertRecord((input.sequence === 1) === (input.previousEventId === null), 'Invalid initial record anchor')
  snapshot(input.snapshot)
  if (input.type === 'run_settled') {
    assertRecord(Number.isSafeInteger(input.inputHistoryLength) && (input.inputHistoryLength as number) >= 0 &&
      (input.inputHistoryLength as number) <= input.snapshot.history.length, 'Invalid canonical input boundary')
    assertHistory(input.snapshot.history.slice(0, input.inputHistoryLength as number).map(entry => entry.message))
    const suffix = input.snapshot.history.slice(input.inputHistoryLength as number)
    assertRecord(suffix.every(entry => entry.message.kind !== 'message'), 'Settled output suffix cannot contain new user/system input')
    const accepted = suffix.filter(entry => entry.message.kind === 'assistant')
    assertRecord(accepted.length === (input.settlement as unknown as AgentRunSettlement).rounds, 'Settlement rounds do not match accepted suffix')
    assertRecord((input.settlement as unknown as AgentRunSettlement).content === (accepted.at(-1)?.message.content ?? ''), 'Settlement content does not match accepted suffix')
  }
  return freeze(structuredClone(input)) as unknown as DurableAgentRecord
}

/** Preserve the final result, including cancellation closures and committed usage after hook failure. */
export function createRunSettlement(options: CreateRunSettlementOptions): DurableAgentRecord {
  assertEventJson(options, AGENT_RECORD_LIMITS.bytes * 3, { nodes: AGENT_RECORD_LIMITS.nodes * 3, depth: AGENT_RECORD_LIMITS.depth })
  keys(options, ['envelope', 'runId', 'inputHistoryLength', 'result', 'history', 'outcomes', 'sessionUsage'])
  keys(options.envelope, ['version', 'sessionId', 'eventId', 'sequence', 'previousEventId', 'source'])
  keys(options.result, ['status', 'history', 'content', 'rounds', 'usage'], ['error'])
  assertRecord(Array.isArray(options.history) && same(options.history.map(entry => entry.message), options.result.history), 'Settlement must preserve the exact reconciled result history')
  const { history: _history, ...final } = options.result
  return decodeAgentRecord({ ...options.envelope, type: 'run_settled', runId: options.runId, inputHistoryLength: options.inputHistoryLength, settlement: final,
    snapshot: { history: options.history, outcomes: options.outcomes, usage: options.sessionUsage } })
}

/** Start at zero; restore from the validated record chain, never a guessed mid-log cursor. */
export function createAgentProjection(sessionId: string): AgentProjection {
  identity(sessionId)
  const output = freeze({ sessionId, sequence: 0, eventId: null, history: [], outcomes: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, runs: [], callBindings: [], receipts: [] })
  projections.add(output)
  return output
}

function checkHistory(previous: AgentProjection, next: DurableAgentRecord): void {
  const history = next.snapshot.history
  assertRecord(history.length >= previous.history.length, 'Snapshot cannot silently delete historical identities')
  for (let index = 0; index < previous.history.length; index++) {
    const before = previous.history[index]!, after = history[index]!
    assertRecord(before.id === after.id, 'Historical message identity or order changed')
    if (same(before, after)) continue
    const privacy = next.type === 'session_snapshot' && next.reason === 'privacy'
    const reconciliation = next.type === 'session_snapshot' && next.reason === 'reconciliation'
    assertRecord(privacy || (reconciliation && before.message.kind === 'tool_result' && after.message.kind === 'tool_result'), 'Historical message changed without explicit reconciliation or privacy rewrite')
    assertRecord(after.source.reference === before.source.reference && after.source.revision !== undefined &&
      after.source.revision !== before.source.revision, 'Rewritten history needs a new revision of its original source')
    const a = before.message, b = after.message
    assertRecord(a.kind === b.kind, 'Rewrite cannot change historical roles')
    if (a.kind === 'message' && b.kind === 'message') assertRecord(a.role === b.role, 'Rewrite cannot change message role')
    if (a.kind === 'assistant' && b.kind === 'assistant') {
      assertRecord(a.toolCalls.length === b.toolCalls.length && a.toolCalls.every((call, callIndex) =>
        call.id === b.toolCalls[callIndex]!.id && call.name === b.toolCalls[callIndex]!.name), 'Rewrite cannot change call identities')
      if (!privacy) assertRecord(same(a, b), 'Only privacy rewrites may change assistant content')
    }
    if (a.kind === 'tool_result' && b.kind === 'tool_result') {
      assertRecord(a.callId === b.callId && a.name === b.name, 'Rewrite cannot change result identity')
      if (!privacy) {
        const beforeEvidence = previous.outcomes.find(item => item.callId === a.callId)
        const afterEvidence = next.snapshot.outcomes.find(item => item.callId === a.callId)
        assertRecord(afterEvidence && (!beforeEvidence || !same(beforeEvidence, afterEvidence)), 'Result reconciliation needs refined exact host evidence')
      }
    }
  }
}

function checkOutcomes(previous: AgentProjection, next: DurableAgentRecord): void {
  for (const before of previous.outcomes) {
    const after = next.snapshot.outcomes.find(item => item.callId === before.callId)
    assertRecord(after, 'Snapshot cannot drop outcome evidence')
    if (same(before, after)) continue
    assertRecord(after.runId === before.runId && after.name === before.name && after.argumentsDigest === before.argumentsDigest, 'Outcome call binding changed')
    assertRecord((before.effect === 'unknown' || before.effect === 'unreported') &&
      (after.effect === 'unknown' || after.effect === 'confirmed' || (before.effect === 'unreported' && after.effect === 'not_attempted')) &&
      after.supersedes === agentEvidenceDigest(before) && after.source.reference === before.source.reference &&
      after.source.revision !== undefined && after.source.revision !== before.source.revision, 'Outcome evidence cannot be weakened or replaced without an exact refinement bridge')
  }
  for (const evidence of next.snapshot.outcomes) {
    const binding = previous.callBindings.find(item => item.callId === evidence.callId)
    if (binding) assertRecord(evidence.runId === binding.runId && evidence.name === binding.name && evidence.argumentsDigest === binding.argumentsDigest, 'Outcome original run/call binding mismatch')
    if (previous.outcomes.some(item => item.callId === evidence.callId)) continue
    const call = next.snapshot.history.flatMap(entry => entry.message.kind === 'assistant' ? entry.message.toolCalls : [])
      .find(item => item.id === evidence.callId)!
    if (next.type === 'run_settled' && next.snapshot.history.slice(next.inputHistoryLength).some(entry => entry.message.kind === 'assistant' && entry.message.toolCalls.some(item => item.id === call.id))) assertRecord(evidence.runId === next.runId, 'New outcome run identity mismatch')
    assertRecord(evidence.argumentsDigest === (binding?.argumentsDigest ?? agentArgumentsDigest(call.arguments)), 'New outcome arguments do not match the exact call')
    assertRecord(evidence.supersedes === undefined, 'New evidence cannot supersede an absent receipt')
  }
}

/** Fold one record. An identical historical repeat returns the current state, never its old snapshot. */
export function applyAgentRecord(previous: AgentProjection, input: unknown): AgentProjection {
  assertRecord(projections.has(previous), 'Projection must be created or replayed by this module')
  const next = decodeAgentRecord(input)
  assertRecord(next.sessionId === previous.sessionId, 'Record session identity mismatch')
  const hash = digest(next), receipt = previous.receipts.find(item => item.eventId === next.eventId)
  if (receipt) {
    assertRecord(receipt.sequence === next.sequence && receipt.digest === hash, 'Conflicting duplicate agent record')
    return previous
  }
  assertRecord(next.sequence === previous.sequence + 1 && next.previousEventId === previous.eventId, 'Agent record gap or predecessor mismatch')
  assertRecord(!(next.type === 'session_snapshot' && next.reason === 'legacy_import' && previous.sequence !== 0), 'Legacy import must be the initial anchor')
  assertRecord(!(previous.sequence === 0 && next.type === 'session_snapshot' && next.reason !== 'legacy_import'), 'Initial snapshot must be an explicit legacy import anchor')
  checkHistory(previous, next); checkOutcomes(previous, next)
  if (next.type === 'run_settled') assertRecord(next.inputHistoryLength >= previous.history.length, 'Run input boundary cannot reassign historical messages')
  if (next.type === 'run_settled') assertRecord(!previous.runs.some(run => run.runId === next.runId), 'Run already has a terminal settlement')
  const bytes = Buffer.byteLength(JSON.stringify(next), 'utf8')
  assertRecord(previous.receipts.reduce((sum, item) => sum + item.bytes, bytes) <= AGENT_RECORD_LIMITS.journalBytes, 'Record journal byte limit exceeded')
  const output: AgentProjection = {
    sessionId: previous.sessionId, sequence: next.sequence, eventId: next.eventId,
    history: next.snapshot.history, outcomes: next.snapshot.outcomes, usage: next.snapshot.usage,
    runs: next.type === 'run_settled' ? [...previous.runs, { runId: next.runId, status: next.settlement.status, rounds: next.settlement.rounds, usage: next.settlement.usage, source: next.source, eventId: next.eventId }] : previous.runs,
    callBindings: next.type === 'run_settled' ? [...previous.callBindings, ...next.snapshot.history.slice(next.inputHistoryLength).flatMap(entry =>
      entry.message.kind === 'assistant' ? entry.message.toolCalls.map(call => ({ callId: call.id, runId: next.runId, name: call.name, argumentsDigest: agentArgumentsDigest(call.arguments) })) : [])] : previous.callBindings,
    receipts: [...previous.receipts, { eventId: next.eventId, sequence: next.sequence, digest: hash, bytes }]
  }
  assertEventJson(output, AGENT_RECORD_LIMITS.projectionBytes, { nodes: AGENT_RECORD_LIMITS.nodes * 4, depth: AGENT_RECORD_LIMITS.depth })
  freeze(output)
  projections.add(output)
  return output
}

/** Atomic full replay: no partial projection is returned if any record is corrupt or missing. */
export function projectAgentRecords(sessionId: string, records: readonly unknown[]): AgentProjection {
  const captured = captureEventArray(records, AGENT_RECORD_LIMITS.records)
  let output = createAgentProjection(sessionId)
  for (let index = 0; index < captured.length; index++) output = applyAgentRecord(output, captured[index])
  return output
}
