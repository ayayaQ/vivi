// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentProjection, projectAgentRecords, createRunSettlement, applyAgentRecord, agentArgumentsDigest } from '../dist/events.js'
import { AGENT_RUN_RECORD_LIMITS, createAgentRunStart, createAgentAcceptedRecord, createAgentRunTerminal,
  createAgentRunProjection, applyAgentRunRecord, projectAgentRunRecords, decodeAgentRunRecord, assertAgentRunCurrent } from '../dist/events/stream.js'

const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
const source = { reference: 'owned/fixture', revision: '1' }
const message = (id, value) => ({ id, source: { reference: `owned/message/${id}`, revision: '1' }, message: value })
function base() {
  return projectAgentRecords('session', [{ version: 1, sessionId: 'session', eventId: 'legacy', sequence: 1,
    previousEventId: null, source, type: 'session_snapshot', reason: 'legacy_import',
    snapshot: { history: [message('original-user-id', { kind: 'message', role: 'user', content: 'Original' })], outcomes: [], usage: zero } }])
}
function header(state) {
  return { version: 1, scope: 'run', sessionId: 'session', runId: 'run', eventId: `run-event-${state.sequence + 1}`,
    sequence: state.sequence + 1, previousEventId: state.eventId, source }
}
function start() {
  const original = base(), waiting = createAgentRunProjection(original, 'run')
  const first = createAgentRunStart(header(waiting), original, [message('new-user-id', { kind: 'message', role: 'user', content: 'New request' })])
  return { original, records: [first], state: applyAgentRunRecord(waiting, first) }
}
function accept(fixture, value, roundUsage, round = fixture.state.rounds + 1) {
  const id = `accepted-${fixture.state.sequence}`
  const update = value.kind === 'assistant'
    ? { type: 'assistant_accepted', message: value, round, ...(roundUsage ? { usage: roundUsage } : {}),
        aggregateUsage: roundUsage ? { ...roundUsage } : { ...zero } }
    : { type: 'tool_result_accepted', message: value, round: fixture.state.rounds }
  const record = createAgentAcceptedRecord({ envelope: header(fixture.state), update, historyId: id, source: message(id, value).source })
  fixture.state = applyAgentRunRecord(fixture.state, record); fixture.records.push(record)
  return record
}
function finish(fixture, extra = [], outcomes = []) {
  const history = [...fixture.state.history, ...extra], assistants = history.slice(fixture.state.inputHistoryLength).filter(item => item.message.kind === 'assistant')
  const result = { status: 'cancelled', history: history.map(item => item.message), rounds: assistants.length,
    content: assistants.at(-1)?.message.content ?? '', usage: fixture.state.runUsage }
  const terminal = createRunSettlement({ envelope: { version: 1, sessionId: 'session', eventId: 'terminal-session-event',
    sequence: fixture.original.sequence + 1, previousEventId: fixture.original.eventId, source },
    runId: 'run', inputHistoryLength: fixture.state.inputHistoryLength, result, history, outcomes, sessionUsage: result.usage })
  const record = createAgentRunTerminal(header(fixture.state), terminal)
  return { record, terminal }
}

test('ordered deltas, complete replay and terminal anchor converge without re-adding legacy history or usage', () => {
  const fixture = start(), usage = { inputTokens: 8, outputTokens: 2, totalTokens: 12, cachedInputTokens: 3 }
  accept(fixture, { kind: 'assistant', content: 'Final', toolCalls: [], providerState: { provider: 'fixture', items: [{ opaque: 'receipt' }] } }, usage)
  const { record, terminal } = finish(fixture)
  const incremental = applyAgentRunRecord(fixture.state, record)
  const full = projectAgentRunRecords(fixture.original, 'run', [...fixture.records, record])
  assert.deepEqual(full, incremental)
  assert.deepEqual(full.session, applyAgentRecord(fixture.original, terminal))
  assert.equal(full.history[0].id, 'original-user-id')
  assert.equal(full.history[1].id, 'new-user-id')
  assert.equal(full.history[2].message.providerState.items[0].opaque, 'receipt')
  assert.equal(full.runUsage.totalTokens, 12)
  assert.equal(full.state, 'settled')
  assert.equal(applyAgentRunRecord(full, fixture.records[0]), full)
  assert.equal(applyAgentRunRecord(full, record), full)
  assert(Object.isFrozen(full.history[2].message.providerState.items[0]))
  assert(!JSON.stringify(full.receipts).includes('Final'))
})

test('an active replay remains incomplete with pending calls and no invented outcome evidence', () => {
  const fixture = start(), call = { id: 'call', name: 'tool', arguments: { value: 1 } }
  accept(fixture, { kind: 'assistant', content: '', toolCalls: [call] }, { inputTokens: 1, outputTokens: 1, totalTokens: 3 })
  const restored = projectAgentRunRecords(fixture.original, 'run', fixture.records)
  assert.deepEqual(restored, fixture.state)
  assert.equal(restored.state, 'running')
  assert.deepEqual(restored.session.outcomes, [])
  assert.equal(restored.history.at(-1).message.toolCalls[0].id, call.id)
  assertAgentRunCurrent(restored, fixture.original)
})

test('strict pending-call/round state rejects skips, wrong results and post-text acceptance', () => {
  const fixture = start(), calls = [{ id: 'first', name: 'tool', arguments: {} }, { id: 'second', name: 'tool', arguments: {} }]
  accept(fixture, { kind: 'assistant', content: '', toolCalls: calls })
  const assistant = createAgentAcceptedRecord({ envelope: header(fixture.state), historyId: 'bad', source,
    update: { type: 'assistant_accepted', round: 2, message: { kind: 'assistant', content: 'Skipped', toolCalls: [] }, aggregateUsage: zero } })
  assert.throws(() => applyAgentRunRecord(fixture.state, assistant), /discard pending/)
  for (const [callId, name, round] of [['second', 'tool', 1], ['first', 'wrong', 1], ['first', 'tool', 2]]) {
    const record = createAgentAcceptedRecord({ envelope: header(fixture.state), historyId: 'bad', source,
      update: { type: 'tool_result_accepted', round, message: { kind: 'tool_result', callId, name, content: '' } } })
    assert.throws(() => applyAgentRunRecord(fixture.state, record), /next pending/)
  }
  const text = start(); accept(text, { kind: 'assistant', content: 'Final', toolCalls: [] })
  const later = { ...structuredClone(text.records[1]), ...header(text.state), round: 2, entry: message('new', { kind: 'assistant', content: 'Extra', toolCalls: [] }) }
  assert.throws(() => applyAgentRunRecord(text.state, later), /text-only/)
})

test('start, session/run identity, predecessor, receipt and trusted-base mismatches fail atomically', () => {
  const fixture = start(), first = fixture.records[0], before = JSON.stringify(fixture.state)
  assert.throws(() => createAgentRunProjection(JSON.parse(JSON.stringify(fixture.original)), 'run'), /created or replayed/)
  assert.throws(() => projectAgentRunRecords(fixture.original, 'run', [{ ...first, baseReceiptDigest: 'a'.repeat(64) }]), /watermark mismatch/)
  assert.throws(() => projectAgentRunRecords(fixture.original, 'other-run', [first]), /identity mismatch/)
  assert.throws(() => applyAgentRunRecord(fixture.state, { ...first, ...header(fixture.state) }), /baseline\/watermark/)
  assert.throws(() => applyAgentRunRecord(fixture.state, { ...first, sessionId: 'other' }), /identity mismatch/)
  const changed = structuredClone(first); changed.input[0].message.content = 'Changed'
  assert.throws(() => applyAgentRunRecord(fixture.state, changed), /Conflicting duplicate/)
  assert.throws(() => applyAgentRunRecord(fixture.state, { ...first, ...header(fixture.state), sequence: 3 }), /gap/)
  assert.equal(JSON.stringify(fixture.state), before)
})

test('terminal can contain unobserved accepted output and cleanup closures after callback failure', () => {
  const fixture = start(), call = { id: 'unseen', name: 'tool', arguments: {} }
  const extra = [message('unseen-assistant', { kind: 'assistant', content: 'Accepted before hook', toolCalls: [call] }),
    message('closure', { kind: 'tool_result', callId: call.id, name: call.name, content: 'Run failed', isError: true })]
  const { record } = finish(fixture, extra)
  const changed = structuredClone(record)
  changed.terminal.settlement.usage = { inputTokens: 8, outputTokens: 2, totalTokens: 12 }
  changed.terminal.snapshot.usage = { inputTokens: 8, outputTokens: 2, totalTokens: 12 }
  const settled = applyAgentRunRecord(fixture.state, changed)
  assert.equal(settled.rounds, 1)
  assert.equal(settled.runUsage.totalTokens, 12)
  assert.equal(settled.history.at(-1).message.callId, call.id)
  assert.deepEqual(settled.session.outcomes, [])
})

test('terminal unseen suffix obeys pending order and cannot add a round after text-only acceptance', () => {
  const text = start(); accept(text, { kind: 'assistant', content: 'Done', toolCalls: [] })
  const postText = finish(text, [message('extra', { kind: 'assistant', content: 'Extra', toolCalls: [] })]).record
  assert.throws(() => applyAgentRunRecord(text.state, postText), /text-only/)
  const unseen = start()
  const repeatedText = finish(unseen, [message('one', { kind: 'assistant', content: 'One', toolCalls: [] }),
    message('two', { kind: 'assistant', content: 'Two', toolCalls: [] })]).record
  assert.throws(() => applyAgentRunRecord(unseen.state, repeatedText), /text-only/)
  const calls = start(), call = { id: 'first', name: 'tool', arguments: {} }
  accept(calls, { kind: 'assistant', content: '', toolCalls: [call] })
  const closure = message('closure', { kind: 'tool_result', callId: call.id, name: call.name, content: 'Cancelled', isError: true })
  const valid = finish(calls, [closure]).record
  assert.equal(applyAgentRunRecord(calls.state, valid).state, 'settled')
})

test('completed stream settlement requires a final accepted text-only assistant', () => {
  const empty = start(), emptyTerminal = structuredClone(finish(empty).record)
  emptyTerminal.terminal.settlement.status = 'completed'
  assert.throws(() => applyAgentRunRecord(empty.state, emptyTerminal), /text-only final/)
  const tools = start(), call = { id: 'only-call', name: 'tool', arguments: {} }
  accept(tools, { kind: 'assistant', content: 'Calling', toolCalls: [call] })
  accept(tools, { kind: 'tool_result', callId: call.id, name: call.name, content: 'Result' })
  const terminal = structuredClone(finish(tools).record)
  terminal.terminal.settlement.status = 'completed'
  assert.throws(() => applyAgentRunRecord(tools.state, terminal), /text-only final/)
  const text = start(); accept(text, { kind: 'assistant', content: 'Done', toolCalls: [] })
  const final = structuredClone(finish(text).record); final.terminal.settlement.status = 'completed'
  assert.equal(applyAgentRunRecord(text.state, final).state, 'settled')
})

test('ordinary accepted-record capacity does not guarantee a representable terminal snapshot', () => {
  const large = start(); accept(large, { kind: 'assistant', content: 'x'.repeat(900_000), toolCalls: [] })
  assert.equal(large.state.state, 'running')
  assert.throws(() => finish(large), /byte limit/)
  assert.equal(large.state.state, 'running')
})

test('terminal rejects altered accepted payloads, wrong input boundaries and stale session successors', () => {
  const fixture = start(); accept(fixture, { kind: 'assistant', content: 'Accepted', toolCalls: [] })
  const { record } = finish(fixture)
  const changed = structuredClone(record); changed.terminal.snapshot.history.at(-1).message.content = 'Changed'; changed.terminal.settlement.content = 'Changed'
  assert.throws(() => applyAgentRunRecord(fixture.state, changed), /cannot rewrite/)
  const boundary = structuredClone(record); boundary.terminal.inputHistoryLength--
  assert.throws(() => applyAgentRunRecord(fixture.state, boundary))
  const stale = structuredClone(record); stale.terminal.eventId = fixture.original.eventId; stale.terminal.sequence = fixture.original.sequence; stale.terminal.previousEventId = null
  assert.throws(() => applyAgentRunRecord(fixture.state, stale), /duplicate|predecessor|gap/)
  const mismatched = structuredClone(record); mismatched.terminal.runId = 'other'
  assert.throws(() => decodeAgentRunRecord(mismatched), /identity mismatch/)
})

test('aggregate usage is exact and omitted cache evidence cannot return through a later round or terminal', () => {
  const fixture = start(), call = { id: 'call', name: 'tool', arguments: {} }
  accept(fixture, { kind: 'assistant', content: '', toolCalls: [call] }, { inputTokens: 1, outputTokens: 2, totalTokens: 5 })
  accept(fixture, { kind: 'tool_result', callId: call.id, name: call.name, content: 'Complete' })
  const update = { type: 'assistant_accepted', round: 2, message: { kind: 'assistant', content: 'Final', toolCalls: [] },
    usage: { inputTokens: 2, outputTokens: 1, totalTokens: 4, cachedInputTokens: 1 }, aggregateUsage: { inputTokens: 3, outputTokens: 3, totalTokens: 9 } }
  const record = createAgentAcceptedRecord({ envelope: header(fixture.state), update, historyId: 'round-2', source })
  const bad = structuredClone(record); bad.aggregateUsage.cachedInputTokens = 1
  assert.throws(() => applyAgentRunRecord(fixture.state, bad), /aggregate usage mismatch/)
  fixture.state = applyAgentRunRecord(fixture.state, record); fixture.records.push(record)
  assert.equal(fixture.state.runUsage.cachedInputTokens, undefined)
  const { record: terminal } = finish(fixture)
  const invented = structuredClone(terminal); invented.terminal.settlement.usage.cachedInputTokens = 1
  assert.throws(() => applyAgentRunRecord(fixture.state, invented), /usage conflicts/)
})

test('exact host evidence with a changed source revision can refine an accepted generic result', () => {
  const fixture = start(), call = { id: 'call', name: 'tool', arguments: { value: 1 } }
  accept(fixture, { kind: 'assistant', content: '', toolCalls: [call] })
  accept(fixture, { kind: 'tool_result', callId: call.id, name: call.name, content: 'Generic error', isError: true })
  const evidence = { callId: call.id, runId: 'run', name: call.name, argumentsDigest: agentArgumentsDigest(call.arguments),
    status: 'succeeded', effect: 'confirmed', source: { reference: 'owned/exact-sidecar', revision: '1' } }
  const { record } = finish(fixture, [], [evidence]), refined = structuredClone(record)
  refined.terminal.snapshot.history.at(-1).message = { kind: 'tool_result', callId: call.id, name: call.name, content: 'Confirmed success' }
  refined.terminal.snapshot.history.at(-1).source.revision = 'reconciled-2'
  assert.equal(applyAgentRunRecord(fixture.state, refined).history.at(-1).message.content, 'Confirmed success')
  refined.terminal.snapshot.outcomes = []
  assert.throws(() => applyAgentRunRecord(fixture.state, refined), /exact host outcome/)
})

test('newer validated privacy cursor invalidates old active-run publication', () => {
  const fixture = start(), privacy = { version: 1, sessionId: 'session', eventId: 'privacy', sequence: 2,
    previousEventId: fixture.original.eventId, source, type: 'session_snapshot', reason: 'privacy',
    snapshot: { history: structuredClone(fixture.original.history), outcomes: [], usage: zero } }
  privacy.snapshot.history[0].message.content = '[withheld]'; privacy.snapshot.history[0].source.revision = '2'
  const current = applyAgentRecord(fixture.original, privacy)
  assert.throws(() => assertAgentRunCurrent(fixture.state, current), /obsolete/)
  assert.throws(() => projectAgentRunRecords(current, 'run', fixture.records), /watermark mismatch/)
  assert.equal(current.history[0].message.content, '[withheld]')
})

test('hostile record/replay containers and unknown formats are rejected before getters or iterators run', () => {
  const fixture = start(); let entered = 0
  const proxy = new Proxy([], { get() { entered++; throw Error('Must not enter') } })
  assert.throws(() => projectAgentRunRecords(fixture.original, 'run', proxy)); assert.equal(entered, 0)
  const chain = [fixture.records[0]]; chain[Symbol.iterator] = function* () { entered++; yield fixture.records[0] }
  assert.throws(() => projectAgentRunRecords(fixture.original, 'run', chain)); assert.equal(entered, 0)
  const getter = structuredClone(fixture.records[0]); Object.defineProperty(getter, 'source', { enumerable: true, get() { entered++; return source } })
  assert.throws(() => decodeAgentRunRecord(getter)); assert.equal(entered, 0)
  for (const changes of [{ version: 2 }, { scope: 'session' }, { type: 'text_delta' }, { approval: true }])
    assert.throws(() => decodeAgentRunRecord({ ...fixture.records[0], ...changes }))
})

test('run record limits reserve a terminal slot and full replay is bounded', () => {
  const fixture = start()
  assert.throws(() => decodeAgentRunRecord({ ...fixture.records[0], sequence: AGENT_RUN_RECORD_LIMITS.records, previousEventId: 'prior' }), /reserved/)
  assert.throws(() => projectAgentRunRecords(fixture.original, 'run', Array(AGENT_RUN_RECORD_LIMITS.records + 1)), /bounded plain array/)
})

test('near-limit existing terminal fits the outer wrapper without changing the old decoder', () => {
  const original = createAgentProjection('session'), waiting = createAgentRunProjection(original, 'run')
  const first = createAgentRunStart(header(waiting), original, [])
  const fixture = { original, records: [first], state: applyAgentRunRecord(waiting, first) }
  accept(fixture, { kind: 'assistant', content: 'x'.repeat(490000), toolCalls: [] })
  const { record } = finish(fixture)
  assert.equal(applyAgentRunRecord(fixture.state, record).state, 'settled')
})
