// SPDX-License-Identifier: Apache-2.0
import type { Usage } from '../types.js'
import { assertHistory } from '../validation.js'
import { assertEventJson, captureEventArray } from './data.js'
import {
  AGENT_RECORD_LIMITS, applyAgentRecord, decodeAgentRecord, agentArgumentsDigest, isAgentProjection,
  assertAgentRecordKeys as keys, assertAgentIdentity as identity, assertAgentSource as source,
  assertAgentUsage as usage, assertAgentHistoryEntry as entry, freezeAgentData as freeze,
  agentDataDigest as digest, assertRecord as check
} from './records.js'
import type { AgentProjection, AgentHistoryEntry, DurableAgentRecord } from './types.js'
import type { AgentRunProjection, AgentRunRecord, AgentRunRecordEnvelope, CreateAgentAcceptedRecordOptions } from './stream-types.js'

export const AGENT_RUN_RECORD_LIMITS = Object.freeze({
  bytes: AGENT_RECORD_LIMITS.bytes, terminalBytes: AGENT_RECORD_LIMITS.bytes * 2,
  depth: AGENT_RECORD_LIMITS.depth + 4, nodes: AGENT_RECORD_LIMITS.nodes * 2,
  records: 4096, journalBytes: 64 * 1024 * 1024, projectionBytes: 16 * 1024 * 1024
})
const projections = new WeakSet<object>()
const envelopeKeys = ['version', 'scope', 'sessionId', 'runId', 'eventId', 'sequence', 'previousEventId', 'source']
const hashPattern = /^[a-f0-9]{64}$/

function envelope(value: unknown): asserts value is AgentRunRecordEnvelope {
  keys(value, envelopeKeys)
  check(value.version === 1 && value.scope === 'run', 'Unsupported run record version or scope')
  identity(value.sessionId); identity(value.runId); identity(value.eventId); source(value.source)
  check(Number.isSafeInteger(value.sequence) && (value.sequence as number) >= 1 &&
    (value.sequence as number) <= AGENT_RUN_RECORD_LIMITS.records, 'Invalid run record sequence')
  if (value.previousEventId !== null) identity(value.previousEventId)
  check((value.sequence === 1) === (value.previousEventId === null), 'Invalid run record initial anchor')
}

/** Already parsed JSON only. Unknown/corrupt versions never become an empty run. */
export function decodeAgentRunRecord(input: unknown): AgentRunRecord {
  assertEventJson(input, AGENT_RUN_RECORD_LIMITS.terminalBytes, AGENT_RUN_RECORD_LIMITS)
  keys(input, [...envelopeKeys, 'type'], ['baseSequence', 'baseEventId', 'baseReceiptDigest', 'input', 'entry', 'round', 'usage', 'aggregateUsage', 'terminal'])
  const { type: _type, baseSequence: _baseSequence, baseEventId: _baseEventId,
    baseReceiptDigest: _baseReceiptDigest, input: _input, entry: _entry, round: _round,
    usage: _usage, aggregateUsage: _aggregateUsage, terminal: _terminal, ...header } = input
  envelope(header)
  if (input.type === 'run_started') {
    keys(input, [...envelopeKeys, 'type', 'baseSequence', 'baseEventId', 'baseReceiptDigest', 'input'])
    check(Number.isSafeInteger(input.baseSequence) && (input.baseSequence as number) >= 0 &&
      (input.baseSequence as number) <= AGENT_RECORD_LIMITS.records, 'Invalid session baseline sequence')
    if (input.baseEventId !== null) identity(input.baseEventId)
    check((input.baseSequence === 0) === (input.baseEventId === null), 'Invalid session baseline identity')
    check(input.baseSequence === 0 ? input.baseReceiptDigest === null :
      typeof input.baseReceiptDigest === 'string' && hashPattern.test(input.baseReceiptDigest), 'Invalid session baseline receipt')
    check(Array.isArray(input.input) && input.input.length <= AGENT_RECORD_LIMITS.history, 'Invalid canonical run input')
    for (const item of input.input) { entry(item); check(item.message.kind === 'message', 'Run input must contain only new user/system messages') }
    assertHistory(input.input.map(item => item.message))
  } else if (input.type === 'assistant_accepted' || input.type === 'tool_result_accepted') {
    keys(input, [...envelopeKeys, 'type', 'entry', 'round'], input.type === 'assistant_accepted' ? ['usage', 'aggregateUsage'] : [])
    entry(input.entry)
    check(input.entry.message.kind === (input.type === 'assistant_accepted' ? 'assistant' : 'tool_result'), 'Accepted record message kind mismatch')
    check(Number.isSafeInteger(input.round) && (input.round as number) >= 1 && (input.round as number) <= 1000, 'Invalid accepted round')
    if (input.type === 'assistant_accepted') {
      check(Object.hasOwn(input, 'aggregateUsage'), 'Accepted assistant must carry aggregate usage')
      usage(input.aggregateUsage); if ('usage' in input) usage(input.usage)
      assertHistory([input.entry.message], true)
    } else {
      const message = input.entry.message
      check(message.kind === 'tool_result' && typeof message.content === 'string', 'Invalid accepted tool result')
      identity(message.callId); identity(message.name)
      if ('isError' in message) check(typeof message.isError === 'boolean', 'Invalid accepted tool result error flag')
    }
  } else {
    check(input.type === 'run_settled', 'Unsupported run record type')
    keys(input, [...envelopeKeys, 'type', 'terminal'])
    const terminal = decodeAgentRecord(input.terminal)
    check(terminal.type === 'run_settled' && terminal.sessionId === input.sessionId && terminal.runId === input.runId,
      'Terminal session/run identity mismatch')
  }
  if (input.type !== 'run_settled') check((input.sequence as number) < AGENT_RUN_RECORD_LIMITS.records, 'Final record slot is reserved for settlement')
  if (input.type !== 'run_settled') assertEventJson(input, AGENT_RUN_RECORD_LIMITS.bytes, AGENT_RUN_RECORD_LIMITS)
  return freeze(structuredClone(input)) as unknown as AgentRunRecord
}

export function createAgentRunStart(header: AgentRunRecordEnvelope, base: AgentProjection,
  input: readonly AgentHistoryEntry[]): AgentRunRecord {
  check(isAgentProjection(base), 'Baseline must be created or replayed by the session module')
  assertEventJson(header, AGENT_RUN_RECORD_LIMITS.bytes); envelope(header)
  return decodeAgentRunRecord({ ...header, type: 'run_started', baseSequence: base.sequence,
    baseEventId: base.eventId, baseReceiptDigest: base.receipts.at(-1)?.digest ?? null, input })
}

/** Convert the opt-in canonical acceptance seam, never AgentEvent progress/tool_started. */
export function createAgentAcceptedRecord(options: CreateAgentAcceptedRecordOptions): AgentRunRecord {
  assertEventJson(options, AGENT_RUN_RECORD_LIMITS.bytes * 2, { nodes: AGENT_RUN_RECORD_LIMITS.nodes, depth: AGENT_RUN_RECORD_LIMITS.depth })
  keys(options, ['envelope', 'update', 'historyId', 'source']); envelope(options.envelope)
  identity(options.historyId); source(options.source)
  const update = options.update
  keys(update, ['type', 'message', 'round'], update.type === 'assistant_accepted' ? ['usage', 'aggregateUsage'] : [])
  check(update.type === 'assistant_accepted' || update.type === 'tool_result_accepted', 'Unsupported canonical acceptance update')
  const common = { ...options.envelope, type: update.type, round: update.round,
    entry: { id: options.historyId, source: options.source, message: update.message } }
  return decodeAgentRunRecord(update.type === 'assistant_accepted' ? {
    ...common, ...('usage' in update ? { usage: update.usage } : {}), aggregateUsage: update.aggregateUsage
  } : common)
}

export function createAgentRunTerminal(header: AgentRunRecordEnvelope, terminal: DurableAgentRecord): AgentRunRecord {
  assertEventJson(header, AGENT_RUN_RECORD_LIMITS.bytes); envelope(header)
  return decodeAgentRunRecord({ ...header, type: 'run_settled', terminal })
}

/** The baseline is validated complete history, not a serialized guessed checkpoint cursor. */
export function createAgentRunProjection(base: AgentProjection, runId: string): AgentRunProjection {
  check(isAgentProjection(base), 'Baseline must be created or replayed by the session module'); identity(runId)
  check(!base.runs.some(run => run.runId === runId), 'Run already settled in the session baseline')
  const output: AgentRunProjection = freeze({ sessionId: base.sessionId, runId, sequence: 0, eventId: null,
    state: 'waiting', baseSequence: base.sequence, baseEventId: base.eventId,
    baseReceiptDigest: base.receipts.at(-1)?.digest ?? null, inputHistoryLength: base.history.length,
    history: base.history, rounds: 0, runUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, session: base, receipts: [] })
  projections.add(output)
  return output
}

function pending(history: readonly AgentHistoryEntry[]): readonly { readonly id: string; readonly name: string }[] {
  let calls: readonly { readonly id: string; readonly name: string }[] = []
  for (const item of history) {
    if (item.message.kind === 'assistant') calls = item.message.toolCalls.map(call => ({id: call.id, name: call.name}))
    else if (item.message.kind === 'tool_result') calls = calls.slice(1)
  }
  return calls
}

function aggregate(previous: AgentRunProjection, reported: Readonly<Usage> | undefined): Usage {
  const value: Usage = { ...previous.runUsage }
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    value[key] += reported?.[key] ?? 0
    check(Number.isSafeInteger(value[key]), 'Aggregate accepted usage overflow')
  }
  for (const key of ['cachedInputTokens', 'cacheWriteInputTokens'] as const) {
    const count = reported?.[key]
    if (count !== undefined && (previous.rounds === 0 || value[key] !== undefined)) {
      value[key] = (value[key] ?? 0) + count
      check(Number.isSafeInteger(value[key]), 'Aggregate accepted cache usage overflow')
    } else delete value[key]
  }
  return value
}

function validateTerminal(previous: AgentRunProjection, terminal: DurableAgentRecord): AgentProjection {
  check(terminal.type === 'run_settled' && terminal.runId === previous.runId &&
    terminal.inputHistoryLength === previous.inputHistoryLength, 'Terminal canonical input boundary mismatch')
  const final = terminal.snapshot.history
  check(final.length >= previous.history.length, 'Terminal cannot drop accepted history')
  for (let index = 0; index < previous.history.length; index++) {
    const before = previous.history[index]!, after = final[index]!
    check(before.id === after.id, 'Terminal accepted message identity/order mismatch')
    if (digest(before) === digest(after)) continue
    // Only an exact stronger host outcome can replace an already-recorded generic result.
    check(before.message.kind === 'tool_result' && after.message.kind === 'tool_result' &&
      before.message.callId === after.message.callId && before.message.name === after.message.name &&
      before.source.reference === after.source.reference && after.source.revision !== undefined &&
      after.source.revision !== before.source.revision, 'Terminal cannot rewrite accepted payload/provenance')
    const callId = before.message.callId
    const call = previous.history.flatMap(item => item.message.kind === 'assistant' ? item.message.toolCalls : [])
      .find(item => item.id === callId)
    const evidence = terminal.snapshot.outcomes.find(item => item.callId === callId)
    check(call && evidence && evidence.runId === previous.runId && evidence.name === call.name &&
      evidence.argumentsDigest === agentArgumentsDigest(call.arguments) && evidence.effect !== 'unreported',
      'Terminal result refinement requires exact host outcome evidence')
  }
  // A hook failure/cancellation may leave accepted messages and cleanup closures unseen.
  // Their final transcript must obey the same canonical transitions as recorded deltas.
  let expected = pending(previous.history)
  let lastAssistant = previous.history.slice(previous.inputHistoryLength)
    .filter(item => item.message.kind === 'assistant').at(-1)?.message
  for (const item of final.slice(previous.history.length)) {
    const message = item.message
    if (message.kind === 'assistant') {
      check(expected.length === 0 && (!lastAssistant ||
        (lastAssistant.kind === 'assistant' && lastAssistant.toolCalls.length > 0)),
        'Terminal assistant cannot discard pending calls or follow a text-only assistant')
      expected = message.toolCalls.map(call => ({ id: call.id, name: call.name }))
      lastAssistant = message
    } else {
      check(message.kind === 'tool_result' && expected[0]?.id === message.callId &&
        expected[0]?.name === message.name, 'Terminal result must match the next pending call')
      expected = expected.slice(1)
    }
  }
  if (terminal.settlement.status === 'completed') check(lastAssistant?.kind === 'assistant' &&
    lastAssistant.toolCalls.length === 0 && terminal.settlement.rounds > 0,
    'Completed run requires an accepted text-only final assistant')
  check(terminal.settlement.rounds >= previous.rounds, 'Terminal cannot lose accepted rounds')
  if (terminal.settlement.rounds === previous.rounds) check(digest(terminal.settlement.usage) === digest(previous.runUsage), 'Terminal usage conflicts with accepted rounds')
  else {
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const)
      check(terminal.settlement.usage[key] >= previous.runUsage[key], 'Terminal cannot lose accepted usage')
    for (const key of ['cachedInputTokens', 'cacheWriteInputTokens'] as const) {
      if (previous.rounds > 0 && previous.runUsage[key] === undefined) check(terminal.settlement.usage[key] === undefined, 'Terminal cannot resurrect unreported cache usage')
      if (previous.runUsage[key] !== undefined && terminal.settlement.usage[key] !== undefined)
        check(terminal.settlement.usage[key]! >= previous.runUsage[key]!, 'Terminal cannot lose reported cache usage')
    }
  }
  // Session order/receipt identity, cumulative effects and original call binding are checked here.
  return applyAgentRecord(previous.session, terminal)
}

/** Fold run-local order. Observation is not a durable append/commit acknowledgement. */
export function applyAgentRunRecord(previous: AgentRunProjection, input: unknown): AgentRunProjection {
  check(projections.has(previous), 'Run projection must be created or replayed by this module')
  const next = decodeAgentRunRecord(input)
  check(next.sessionId === previous.sessionId && next.runId === previous.runId, 'Run record identity mismatch')
  const hash = digest(next), receipt = previous.receipts.find(item => item.eventId === next.eventId)
  if (receipt) { check(receipt.sequence === next.sequence && receipt.digest === hash, 'Conflicting duplicate run record'); return previous }
  check(previous.state !== 'settled', 'Run already has a terminal record')
  check(next.sequence === previous.sequence + 1 && next.previousEventId === previous.eventId, 'Run record gap or predecessor mismatch')
  let history = previous.history, rounds = previous.rounds, runUsage = previous.runUsage,
    session = previous.session, inputHistoryLength = previous.inputHistoryLength
  let state: AgentRunProjection['state'] = 'running'
  if (next.type === 'run_started') {
    check(previous.state === 'waiting' && next.baseSequence === previous.baseSequence &&
      next.baseEventId === previous.baseEventId && next.baseReceiptDigest === previous.baseReceiptDigest,
      'Run start baseline/watermark mismatch')
    history = [...history, ...next.input]; inputHistoryLength = history.length
    assertHistory(history.map(item => item.message))
  } else {
    check(previous.state === 'running', 'Run must start before accepting records')
    if (next.type === 'assistant_accepted') {
      const lastAssistant = history.slice(previous.inputHistoryLength).filter(item => item.message.kind === 'assistant').at(-1)?.message
      check(!lastAssistant || (lastAssistant.kind === 'assistant' && lastAssistant.toolCalls.length > 0), 'Acceptance cannot follow a text-only assistant')
      check(pending(history).length === 0, 'Accepted assistant cannot discard pending calls')
      check(next.round === rounds + 1, 'Accepted assistant round gap')
      const total = aggregate(previous, next.usage)
      check(digest(total) === digest(next.aggregateUsage), 'Accepted aggregate usage mismatch')
      history = [...history, next.entry]; rounds = next.round; runUsage = total
    } else if (next.type === 'tool_result_accepted') {
      const expected = pending(history)[0], message = next.entry.message
      check(next.round === rounds && expected && message.kind === 'tool_result' &&
        message.callId === expected.id && message.name === expected.name, 'Accepted result must match next pending call/round')
      history = [...history, next.entry]
    } else {
      session = validateTerminal(previous, next.terminal); history = session.history
      check(next.terminal.type === 'run_settled', 'Expected run terminal')
      rounds = next.terminal.settlement.rounds; runUsage = next.terminal.settlement.usage; state = 'settled'
    }
  }
  check(history.length + (state === 'settled' ? 0 : pending(history).length) <= AGENT_RECORD_LIMITS.history && new Set(history.map(item => item.id)).size === history.length,
    'History identity/count limit exceeded')
  assertHistory(history.map(item => item.message), state !== 'settled')
  const bytes = Buffer.byteLength(JSON.stringify(next), 'utf8')
  check(previous.receipts.reduce((sum, item) => sum + item.bytes, bytes) <= AGENT_RUN_RECORD_LIMITS.journalBytes - (state === 'settled' ? 0 : AGENT_RUN_RECORD_LIMITS.terminalBytes), 'Run journal byte limit exceeded')
  const output: AgentRunProjection = { ...previous, sequence: next.sequence, eventId: next.eventId, state,
    history, rounds, runUsage, session, inputHistoryLength,
    receipts: [...previous.receipts, { eventId: next.eventId, sequence: next.sequence, digest: hash, bytes }] }
  assertEventJson(output, AGENT_RUN_RECORD_LIMITS.projectionBytes, { nodes: AGENT_RECORD_LIMITS.nodes * 8, depth: AGENT_RUN_RECORD_LIMITS.depth })
  freeze(output); projections.add(output)
  return output
}

/** Replay requires the validated prior session anchor and the complete ordered run chain. */
export function projectAgentRunRecords(base: AgentProjection, runId: string, records: readonly unknown[]): AgentRunProjection {
  const captured = captureEventArray(records, AGENT_RUN_RECORD_LIMITS.records)
  let output = createAgentRunProjection(base, runId)
  for (let index = 0; index < captured.length; index++) output = applyAgentRunRecord(output, captured[index])
  return output
}

/** Host admission/publication check: a newer session/privacy cursor invalidates this active run. */
export function assertAgentRunCurrent(run: AgentRunProjection, currentSession: AgentProjection): void {
  check(projections.has(run) && isAgentProjection(currentSession), 'Currentness requires validated projections')
  check(run.state !== 'settled' && currentSession.sessionId === run.sessionId &&
    currentSession.sequence === run.baseSequence && currentSession.eventId === run.baseEventId &&
    (currentSession.receipts.at(-1)?.digest ?? null) === run.baseReceiptDigest, 'Active run baseline is obsolete')
}
