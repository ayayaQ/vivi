// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { runAgent } from '../dist/index.js'
import {
  AGENT_RECORD_LIMITS, decodeAgentRecord, agentArgumentsDigest, agentEvidenceDigest,
  createRunSettlement, createAgentProjection, applyAgentRecord, projectAgentRecords
} from '../dist/events.js'

const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
const source = { reference: 'host/session/original', revision: '1' }
const entries = messages => messages.map((message, index) => ({ id: `message-${index}`, source: structuredClone(source), message }))
function record(overrides = {}) {
  return {
    version: 1, type: 'session_snapshot', reason: 'legacy_import', sessionId: 'session',
    eventId: 'event-1', sequence: 1, previousEventId: null, source: structuredClone(source),
    snapshot: { history: entries([{ kind: 'message', role: 'user', content: 'Original' }]), outcomes: [], usage: structuredClone(zero) },
    ...overrides
  }
}
function next(previous, overrides = {}) {
  return record({ reason: 'reconciliation', eventId: `event-${previous.sequence + 1}`, sequence: previous.sequence + 1,
    previousEventId: previous.eventId, snapshot: structuredClone(previous.snapshot), ...overrides })
}
function toolRecord(effect = 'unknown', status = 'unknown') {
  const call = { id: 'call', name: 'tool', arguments: { value: 1 } }
  return record({ snapshot: {
    history: entries([{ kind: 'assistant', content: '', toolCalls: [call] },
      { kind: 'tool_result', callId: call.id, name: call.name, content: 'Outcome unknown', isError: true }]),
    outcomes: [{ callId: call.id, runId: 'original-run', name: call.name,
      argumentsDigest: agentArgumentsDigest(call.arguments), effect, status, source }], usage: structuredClone(zero)
  } })
}

test('decoder captures frozen detached bounded data and exact role/source provenance', () => {
  const input = record(), output = decodeAgentRecord(input)
  input.snapshot.history[0].message.content = 'Changed'
  assert.equal(output.snapshot.history[0].message.content, 'Original')
  assert.equal(output.snapshot.history[0].message.role, 'user')
  assert.deepEqual(output.snapshot.history[0].source, source)
  assert(Object.isFrozen(output.snapshot.history[0].message))
  assert.throws(() => { output.snapshot.usage.inputTokens = 1 }, TypeError)
})

test('ordered full replay and incremental folds are identical; old duplicates return current state', () => {
  const first = record(), second = next(first)
  second.snapshot.history.push({ id: 'assistant', source, message: { kind: 'assistant', content: 'Final', toolCalls: [] } })
  second.snapshot.usage = { inputTokens: 8, outputTokens: 2, totalTokens: 12 }
  const full = projectAgentRecords('session', [first, second])
  const incremental = applyAgentRecord(applyAgentRecord(createAgentProjection('session'), first), second)
  assert.deepEqual(full, incremental)
  assert.equal(applyAgentRecord(incremental, first), incremental)
  assert.equal(applyAgentRecord(incremental, second), incremental)
  assert.equal(full.usage.totalTokens, 12)
  assert.equal(full.usage.cachedInputTokens, undefined)
  assert(full.receipts.every(item => /^[a-f0-9]{64}$/.test(item.digest)))
  assert(!JSON.stringify(full.receipts).includes('Original'))
})

for (const [name, mutate] of [
  ['unsupported major version', item => { item.version = 2 }],
  ['unknown record kind', item => { item.type = 'text_delta' }],
  ['unrecognized fields', item => { item.approval = true }],
  ['negative counter', item => { item.snapshot.usage.totalTokens = -1 }],
  ['unsafe counter', item => { item.snapshot.usage.totalTokens = Number.MAX_SAFE_INTEGER + 1 }],
  ['fractional sequence', item => { item.sequence = 1.1 }],
  ['unknown role', item => { item.snapshot.history[0].message.role = 'developer' }],
  ['duplicate message identity', item => { item.snapshot.history.push(structuredClone(item.snapshot.history[0])) }],
  ['transient history', item => { item.snapshot.history[0].message = { kind: 'text_delta', content: 'partial' } }],
  ['pending canonical call', item => { item.snapshot.history = entries([{ kind: 'assistant', content: '', toolCalls: [{ id: 'pending', name: 'tool', arguments: {} }] }]) }],
  ['forged provider receipt', item => { item.snapshot.history = entries([{ kind: 'assistant', content: '', toolCalls: [], providerState: { provider: 'fixture', items: [], approval: true } }]) }],
  ['oversized record', item => { item.snapshot.history[0].message.content = 'x'.repeat(AGENT_RECORD_LIMITS.bytes) }],
  ['oversized identifier', item => { item.eventId = 'x'.repeat(AGENT_RECORD_LIMITS.identity + 1) }]
]) test(`decoder rejects ${name}`, () => {
  const input = record(); mutate(input); assert.throws(() => decodeAgentRecord(input))
})

test('descriptor validation rejects hostile getters, proxies, cycles, sparse arrays and deep nesting without invoking getters', () => {
  let entered = 0
  const accessor = record(); Object.defineProperty(accessor, 'source', { enumerable: true, get() { entered++; throw Error('Do not enter') } })
  assert.throws(() => decodeAgentRecord(accessor)); assert.equal(entered, 0)
  const proxy = new Proxy(record(), { get() { entered++; throw Error('Do not enter') } })
  assert.throws(() => decodeAgentRecord(proxy)); assert.equal(entered, 0)
  const cycle = record(); cycle.source.reference = cycle; assert.throws(() => decodeAgentRecord(cycle))
  const sparse = record(); sparse.snapshot.history = Array(1); assert.throws(() => decodeAgentRecord(sparse))
  let deep = {}; for (let i = 0; i < 40; i++) deep = { child: deep }
  assert.throws(() => agentArgumentsDigest(deep), /complexity/)
})

test('session mismatch, gaps, conflicting duplicates and a guessed restore watermark fail without mutating prior state', () => {
  const first = record(), state = projectAgentRecords('session', [first]), before = JSON.stringify(state)
  assert.throws(() => applyAgentRecord(state, next(first, { sessionId: 'other' })), /identity mismatch/)
  assert.throws(() => applyAgentRecord(state, next(first, { sequence: 3 })), /gap/)
  assert.throws(() => applyAgentRecord(state, next(first, { previousEventId: 'wrong' })), /predecessor/)
  const conflicting = structuredClone(first); conflicting.snapshot.usage.inputTokens = 1
  assert.throws(() => applyAgentRecord(state, conflicting), /Conflicting duplicate/)
  assert.throws(() => projectAgentRecords('session', [next(first)]), /gap/)
  assert.throws(() => applyAgentRecord(JSON.parse(JSON.stringify(state)), next(first)), /created or replayed/)
  assert.equal(JSON.stringify(state), before)
})

test('retained identities cannot hide payload changes, reordered messages or deleted history', () => {
  const first = toolRecord(), state = projectAgentRecords('session', [first])
  const changed = next(first); changed.snapshot.history[0].message.toolCalls[0].arguments.value = 2
  assert.throws(() => applyAgentRecord(state, changed), /Historical message changed/)
  const reordered = next(first); reordered.snapshot.history.reverse()
  assert.throws(() => applyAgentRecord(state, reordered))
  const missing = next(first); missing.snapshot.history = []
  assert.throws(() => applyAgentRecord(state, missing))
})

test('outcome evidence remains exact and cumulative; unknown can refine to a confirmed host receipt', () => {
  const first = toolRecord(), state = projectAgentRecords('session', [first])
  const orphan = toolRecord(); orphan.snapshot.outcomes[0].callId = 'absent'; assert.throws(() => decodeAgentRecord(orphan))
  const mismatch = toolRecord(); mismatch.snapshot.outcomes[0].argumentsDigest = agentArgumentsDigest({ value: 2 })
  assert.throws(() => projectAgentRecords('session', [mismatch]), /arguments do not match/)
  const dropped = next(first); dropped.snapshot.outcomes = []; assert.throws(() => applyAgentRecord(state, dropped), /drop outcome/)
  const noSend = next(first); noSend.snapshot.outcomes[0].effect = 'not_attempted'; assert.throws(() => applyAgentRecord(state, noSend))
  const confirmed = next(first), old = confirmed.snapshot.outcomes[0]
  confirmed.snapshot.outcomes[0] = { ...old, effect: 'confirmed', status: 'succeeded',
    source: { ...source, revision: '2' }, supersedes: agentEvidenceDigest(old) }
  confirmed.snapshot.history[1].message = { ...confirmed.snapshot.history[1].message, content: 'Confirmed success', isError: false }
  confirmed.snapshot.history[1].source = { ...source, revision: '2' }
  const advanced = applyAgentRecord(state, confirmed)
  assert.equal(advanced.outcomes[0].effect, 'confirmed')
  const weaken = next(confirmed); weaken.snapshot.outcomes[0].effect = 'unknown'
  assert.throws(() => applyAgentRecord(advanced, weaken), /cannot be weakened/)
})

test('explicit privacy checkpoint retains IDs/call receipt bridges; historical duplicate cannot restore secret content', () => {
  const first = toolRecord(); first.snapshot.history[0].message.toolCalls[0].arguments = { token: 'synthetic-secret' }
  first.snapshot.outcomes[0].argumentsDigest = agentArgumentsDigest({ token: 'synthetic-secret' })
  const state = projectAgentRecords('session', [first]), privacy = next(first, { reason: 'privacy' })
  privacy.snapshot.history[0].message.toolCalls[0].arguments = { token: '[withheld]' }
  privacy.snapshot.history[0].source = { ...source, revision: 'redacted-2' }
  const clean = applyAgentRecord(state, privacy)
  assert(!JSON.stringify(clean).includes('synthetic-secret'))
  assert.equal(clean.outcomes[0].argumentsDigest, first.snapshot.outcomes[0].argumentsDigest)
  assert.equal(applyAgentRecord(clean, first), clean)
  assert.deepEqual(projectAgentRecords('session', [first, privacy]), clean)
})

test('terminal helper preserves zero-round cancellation with prior assistant history and never invents evidence', async () => {
  const messages = [{ kind: 'assistant', content: 'Previous answer', toolCalls: [] }], controller = new AbortController()
  controller.abort()
  const result = await runAgent({ messages, tools: [], signal: controller.signal,
    provider: { generate() { throw Error('Must not enter') } }, executeTool() { throw Error('Must not enter') } })
  const terminal = createRunSettlement({ envelope: { version: 1, sessionId: 'session', eventId: 'event-1', sequence: 1,
    previousEventId: null, source }, runId: 'run', inputHistoryLength: messages.length, result, history: entries(result.history), outcomes: [], sessionUsage: zero })
  assert.equal(terminal.settlement.content, '')
  assert.equal(terminal.settlement.rounds, 0)
  assert.equal(terminal.snapshot.history[0].message.content, 'Previous answer')
  const projected = projectAgentRecords('session', [terminal]); assert.equal(projected.runs[0].status, 'cancelled')
  const altered = { ...result, history: [] }
  assert.throws(() => createRunSettlement({ envelope: { version: 1, sessionId: 'session', eventId: 'event-1', sequence: 1, previousEventId: null, source }, runId: 'other', inputHistoryLength: 0, result: altered,
    history: entries(result.history), outcomes: [], sessionUsage: zero }), /exact reconciled/)
  const repeatedRun = { ...structuredClone(terminal), sequence: 2, previousEventId: terminal.eventId, eventId: 'event-2' }
  assert.throws(() => applyAgentRecord(projected, repeatedRun), /already has/)
})

test('privacy rewrite may remove provider-native state without interpreting it', () => {
  const first = record({ snapshot: { history: entries([{ kind: 'assistant', content: 'Final', toolCalls: [],
    providerState: { provider: 'fixture', items: [{ private: 'synthetic-sensitive-state' }] } }]), outcomes: [], usage: structuredClone(zero) } })
  const state = projectAgentRecords('session', [first]), privacy = next(first, { reason: 'privacy' })
  delete privacy.snapshot.history[0].message.providerState
  privacy.snapshot.history[0].source = { ...source, revision: '2' }
  assert.equal(applyAgentRecord(state, privacy).history[0].message.providerState, undefined)
})

test('chain and record-count limits fail closed rather than compacting or dropping history', () => {
  assert.throws(() => projectAgentRecords('session', Array(AGENT_RECORD_LIMITS.records + 1)), /bounded plain array/)
  const tooLate = record({ sequence: AGENT_RECORD_LIMITS.records + 1, previousEventId: 'previous' })
  assert.throws(() => decodeAgentRecord(tooLate), /sequence/)
})

test('cumulative full-snapshot storage is bounded and duplicates consume no additional bytes', () => {
  const first = record()
  first.snapshot.history[0].message.content = 'x'.repeat(900000)
  let state = applyAgentRecord(createAgentProjection('session'), first), previous = first
  const required = Math.floor(AGENT_RECORD_LIMITS.journalBytes / state.receipts[0].bytes)
  for (let index = 1; index < required; index++) {
    previous = next(previous)
    state = applyAgentRecord(state, previous)
  }
  assert.equal(applyAgentRecord(state, first), state)
  const before = state.sequence
  assert.throws(() => applyAgentRecord(state, next(previous)), /journal byte limit/)
  assert.equal(state.sequence, before)
})

test('later evidence binds the original accepted run even when its terminal omitted evidence', async () => {
  const messages = [{ kind: 'message', role: 'user', content: 'Owned fixture' }]
  const call = { id: 'late-evidence-call', name: 'tool', arguments: { value: 1 } }
  const result = await runAgent({ messages, tools: [{ name: 'tool', description: '', parameters: {} }], maxRounds: 1,
    provider: { async generate() { return { content: '', toolCalls: [call] } } }, async executeTool() { return { content: 'Complete' } } })
  const first = createRunSettlement({ envelope: { version: 1, sessionId: 'session', eventId: 'event-1', sequence: 1, previousEventId: null, source },
    runId: 'actual-run', inputHistoryLength: messages.length, result, history: entries(result.history), outcomes: [], sessionUsage: zero })
  const state = projectAgentRecords('session', [first]), follow = next(first)
  follow.type = 'session_snapshot'; follow.reason = 'reconciliation'; delete follow.runId; delete follow.inputHistoryLength; delete follow.settlement
  follow.snapshot.outcomes = [{ callId: call.id, runId: 'unrelated-run', name: call.name, argumentsDigest: agentArgumentsDigest(call.arguments),
    status: 'succeeded', effect: 'confirmed', source }]
  assert.throws(() => applyAgentRecord(state, follow), /original run\/call binding/)
  follow.snapshot.outcomes[0].runId = 'actual-run'
  assert.equal(applyAgentRecord(state, follow).outcomes[0].runId, 'actual-run')
  assert.equal(state.callBindings[0].runId, 'actual-run')
  const interruptedBoundary = { ...structuredClone(first), inputHistoryLength: messages.length + 1, settlement: { ...first.settlement, content: '', rounds: 0 } }
  assert.throws(() => decodeAgentRecord(interruptedBoundary), /unanswered tool calls/)
  const forgedBoundary = { ...structuredClone(first), inputHistoryLength: 0 }
  assert.throws(() => decodeAgentRecord({ ...forgedBoundary, settlement: { ...forgedBoundary.settlement, rounds: 0 } }), /accepted suffix|new user/)
})


test('full replay rejects proxy/symbol iterators, sparse or accessor chains before caller code runs', () => {
  let entered = 0
  const proxy = new Proxy([], { get() { entered++; throw Error('Do not enter') } })
  assert.throws(() => projectAgentRecords('session', proxy)); assert.equal(entered, 0)
  const custom = [record()]
  custom[Symbol.iterator] = function* () { entered++; yield record() }
  assert.throws(() => projectAgentRecords('session', custom)); assert.equal(entered, 0)
  const accessor = [record()]
  Object.defineProperty(accessor, '0', { enumerable: true, get() { entered++; return record() } })
  assert.throws(() => projectAgentRecords('session', accessor)); assert.equal(entered, 0)
  assert.throws(() => projectAgentRecords('session', Array(1)))
})

test('terminal helper accepts a valid near-node-budget receipt despite duplicated input data', () => {
  const result = { status: 'completed', history: [{ kind: 'assistant', content: 'Large opaque receipt', toolCalls: [],
    providerState: { provider: 'fixture', items: Array(40000).fill(0) } }], content: 'Large opaque receipt', rounds: 1, usage: zero }
  const terminal = createRunSettlement({ envelope: { version: 1, sessionId: 'session', eventId: 'event-1', sequence: 1, previousEventId: null, source },
    runId: 'run', inputHistoryLength: 0, result, history: entries(result.history), outcomes: [], sessionUsage: zero })
  assert.equal(decodeAgentRecord(terminal).snapshot.history[0].message.providerState.items.length, 40000)
})


test('terminal helper rejects hidden output fields in its exact envelope contract', () => {
  const result = { status: 'completed', history: [{ kind: 'assistant', content: 'Final', toolCalls: [] }], content: 'Final', rounds: 1, usage: zero }
  assert.throws(() => createRunSettlement({ envelope: { version: 1, sessionId: 'session', eventId: 'event-1', sequence: 1, previousEventId: null, source, type: 'overwritten' },
    runId: 'run', inputHistoryLength: 0, result, history: entries(result.history), outcomes: [], sessionUsage: zero }), /unsupported record fields/)
})
