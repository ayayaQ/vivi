// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { runAgent } from '../dist/index.js'
import {
  createAgentProjection, applyAgentRecord, projectAgentRecords, decodeAgentRecord, createRunSettlement
} from '../dist/events.js'
import {
  createAgentRunStart, createAgentAcceptedRecord, createAgentRunTerminal,
  createAgentRunProjection, applyAgentRunRecord, projectAgentRunRecords, decodeAgentRunRecord
} from '../dist/events/stream.js'

const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
const source = { reference: 'owned/steering-fixture', revision: '1' }
const user = content => ({ kind: 'message', role: 'user', content })
const assistant = (content, toolCalls = []) => ({ kind: 'assistant', content, toolCalls })
const result = call => ({ kind: 'tool_result', callId: call.id, name: call.name, content: 'Complete' })
const entry = (id, message) => ({ id, source: { reference: `owned/messages/${id}`, revision: '1' }, message })
function header(state) {
  return { version: 1, scope: 'run', sessionId: 'session', runId: 'run', eventId: `run-${state.sequence + 1}`,
    sequence: state.sequence + 1, previousEventId: state.eventId, source }
}
function start() {
  const base = projectAgentRecords('session', [{ version: 1, sessionId: 'session', eventId: 'legacy', sequence: 1,
    previousEventId: null, source, type: 'session_snapshot', reason: 'legacy_import',
    snapshot: { history: [entry('original', user('Original'))], outcomes: [], usage: zero } }])
  const waiting = createAgentRunProjection(base, 'run')
  const first = createAgentRunStart(header(waiting), base, [entry('initial', user('Initial request'))])
  return { base, records: [first], state: applyAgentRunRecord(waiting, first) }
}
function total(state, usage) {
  const sum = { ...state.runUsage }
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) sum[key] += usage?.[key] ?? 0
  for (const key of ['cachedInputTokens', 'cacheWriteInputTokens']) {
    if (usage?.[key] !== undefined && (state.rounds === 0 || sum[key] !== undefined)) sum[key] = (sum[key] ?? 0) + usage[key]
    else delete sum[key]
  }
  return sum
}
function accepted(fixture, message, { id = `accepted-${fixture.state.sequence}`, round, usage } = {}) {
  const type = message.kind === 'assistant' ? 'assistant_accepted' :
    message.kind === 'tool_result' ? 'tool_result_accepted' : 'user_message_accepted'
  const update = { type, message, round: round ?? (message.kind === 'assistant' ? fixture.state.rounds + 1 : fixture.state.rounds),
    ...(message.kind === 'assistant' ? { ...(usage ? { usage } : {}), aggregateUsage: total(fixture.state, usage) } : {}) }
  return createAgentAcceptedRecord({ envelope: header(fixture.state), update, historyId: id, source: entry(id, message).source })
}
function accept(fixture, message, options) {
  const record = accepted(fixture, message, options)
  fixture.state = applyAgentRunRecord(fixture.state, record); fixture.records.push(record)
  return record
}
function settlement(fixture, extra = [], status = 'cancelled', usage = fixture.state.runUsage) {
  const history = [...fixture.state.history, ...extra]
  const assistants = history.slice(fixture.state.inputHistoryLength).filter(item => item.message.kind === 'assistant')
  const result = { status, history: history.map(item => item.message), rounds: assistants.length,
    content: assistants.at(-1)?.message.content ?? '', usage,
    ...(status === 'error' ? { error: { code: 'event_error', message: 'Acceptance hook failed' } } : {}) }
  return createRunSettlement({ envelope: { version: 1, sessionId: 'session', eventId: 'session-terminal',
    sequence: fixture.base.sequence + 1, previousEventId: fixture.base.eventId, source },
    runId: 'run', inputHistoryLength: fixture.state.inputHistoryLength, result, history, outcomes: [], sessionUsage: usage })
}
function finish(fixture, extra = [], status = 'cancelled', usage) {
  const terminal = settlement(fixture, extra, status, usage)
  return { terminal, record: createAgentRunTerminal(header(fixture.state), terminal) }
}

test('steering deltas converge with terminal/session replay while retaining FIFO duplicates and exact usage', () => {
  const fixture = start(), calls = [{ id: 'one', name: 'tool', arguments: {} }, { id: 'two', name: 'tool', arguments: {} }]
  const firstUsage = { inputTokens: 8, outputTokens: 2, totalTokens: 12, cachedInputTokens: 3 }
  accept(fixture, assistant('Calling', calls), { usage: firstUsage })
  for (const call of calls) accept(fixture, result(call))
  const before = { rounds: fixture.state.rounds, usage: fixture.state.runUsage }
  const first = accept(fixture, user('Same content'), { id: 'steer-one' })
  const second = accept(fixture, user('Same content'), { id: 'steer-two' })
  assert.equal(first.round, 1); assert.equal(second.round, 1)
  assert.equal(fixture.state.rounds, before.rounds); assert.deepEqual(fixture.state.runUsage, before.usage)
  assert(!Object.hasOwn(first, 'usage')); assert(!Object.hasOwn(first, 'aggregateUsage'))
  assert.notEqual(first.entry.id, second.entry.id); assert.notEqual(first.entry.source.reference, second.entry.source.reference)
  accept(fixture, assistant('First answer'), { usage: { inputTokens: 2, outputTokens: 1, totalTokens: 4, cachedInputTokens: 1 } })
  accept(fixture, user('Continue'), { id: 'steer-three' })
  accept(fixture, assistant('Final answer'), { usage: { inputTokens: 1, outputTokens: 3, totalTokens: 5, cachedInputTokens: 0 } })
  const { terminal, record } = finish(fixture, [], 'completed')
  const folded = applyAgentRunRecord(fixture.state, record)
  const replayed = projectAgentRunRecords(fixture.base, 'run', [...fixture.records, record])
  assert.deepEqual(replayed, folded)
  assert.deepEqual(replayed.session, applyAgentRecord(fixture.base, terminal))
  assert.deepEqual(replayed.runUsage, { inputTokens: 11, outputTokens: 6, totalTokens: 21, cachedInputTokens: 4 })
  assert.equal(replayed.rounds, 3)
  assert.deepEqual(replayed.history.filter(item => item.id.startsWith('steer-')).map(item => item.id), ['steer-one', 'steer-two', 'steer-three'])
  assert.equal(applyAgentRunRecord(replayed, first), replayed)
  assert.equal(applyAgentRunRecord(replayed, record), replayed)
})

test('user acceptance requires a started run, prior provider round and matching completed-round number', () => {
  const fixture = start(), before = JSON.stringify(fixture.state)
  const premature = accepted(fixture, user('Too soon'), { round: 1 })
  assert.throws(() => applyAgentRunRecord(fixture.state, premature), /current completed round/)
  const waiting = createAgentRunProjection(createAgentProjection('session'), 'run')
  const noStart = createAgentAcceptedRecord({ envelope: header(waiting), historyId: 'no-start', source,
    update: { type: 'user_message_accepted', message: user('No start'), round: 1 } })
  assert.throws(() => applyAgentRunRecord(waiting, noStart), /must start/)
  assert.equal(JSON.stringify(fixture.state), before)
  accept(fixture, assistant('Done'))
  const incorrect = accepted(fixture, user('Wrong round'), { round: 2 })
  assert.throws(() => applyAgentRunRecord(fixture.state, incorrect), /current completed round/)
  for (const round of [0, -1, 1.5, 1001])
    assert.throws(() => accepted(fixture, user('Invalid'), { round }), /Invalid accepted round/)
  accept(fixture, user('Valid'))
  assert.equal(fixture.state.rounds, 1)
})

test('user messages cannot split any part of a pending tool batch', () => {
  const fixture = start(), calls = [{ id: 'one', name: 'tool', arguments: {} }, { id: 'two', name: 'tool', arguments: {} }]
  accept(fixture, assistant('Calling', calls))
  assert.throws(() => applyAgentRunRecord(fixture.state, accepted(fixture, user('Early'))), /split pending/)
  accept(fixture, result(calls[0]))
  assert.throws(() => applyAgentRunRecord(fixture.state, accepted(fixture, user('Between'))), /split pending/)
  accept(fixture, result(calls[1]))
  accept(fixture, user('After the full batch'))
  accept(fixture, assistant('Done'))
  assert.equal(fixture.state.rounds, 2)
})

test('text-only assistant continuation requires an intervening accepted user', () => {
  const fixture = start(); accept(fixture, assistant('First answer'))
  assert.throws(() => applyAgentRunRecord(fixture.state, accepted(fixture, assistant('Unrequested continuation'))), /text-only/)
  accept(fixture, user('Follow-up'))
  accept(fixture, assistant('Second answer'))
  assert.throws(() => applyAgentRunRecord(fixture.state, accepted(fixture, assistant('Another continuation'))), /text-only/)
  assert.equal(projectAgentRunRecords(fixture.base, 'run', fixture.records).rounds, 2)
})

test('user records capture frozen detached provenance and reject forged usage, roles, fields and formats', () => {
  const fixture = start(); accept(fixture, assistant('Ready'))
  const input = { envelope: header(fixture.state), historyId: 'steer', source: { reference: 'owned/queue/item', revision: '4' },
    update: { type: 'user_message_accepted', message: user('Original'), round: 1 } }
  const record = createAgentAcceptedRecord(input)
  input.source.reference = 'changed'; input.update.message.content = 'Changed'
  assert.equal(record.entry.message.content, 'Original'); assert.equal(record.entry.source.reference, 'owned/queue/item')
  assert(Object.isFrozen(record.entry.source)); assert(Object.isFrozen(record.entry.message))
  assert.throws(() => { record.entry.source.revision = '5' }, TypeError)
  for (const message of [{ kind: 'message', role: 'system', content: 'System' }, assistant('Assistant'),
    { kind: 'tool_result', callId: 'id', name: 'tool', content: '' }, { kind: 'message', role: 'user', content: 1 }]) {
    const changed = structuredClone(record); changed.entry.message = message
    assert.throws(() => decodeAgentRunRecord(changed))
  }
  for (const changes of [{ version: 0 }, { version: 3 }, { scope: 'session' }, { type: 'user_accepted' },
    { usage: zero }, { aggregateUsage: zero }, { approval: true }, { executor: 'restore' }])
    assert.throws(() => decodeAgentRunRecord({ ...record, ...changes }))
  for (const extra of [{ usage: zero }, { aggregateUsage: zero }, { permission: true }])
    assert.throws(() => createAgentAcceptedRecord({ ...input, update: { ...input.update, ...extra } }), /unsupported record fields/)
  const hostile = structuredClone(record); let entered = 0
  Object.defineProperty(hostile.entry.message, 'content', { enumerable: true, get() { entered++; return 'Never read' } })
  assert.throws(() => decodeAgentRunRecord(hostile)); assert.equal(entered, 0)
})

test('terminal can recover an unseen admitted user suffix on cancellation or acceptance-hook failure', () => {
  for (const status of ['cancelled', 'error']) {
    const fixture = start(); accept(fixture, assistant('First answer'), { usage: { inputTokens: 2, outputTokens: 3, totalTokens: 7 } })
    const extra = [entry('unseen-one', user('Same')), entry('unseen-two', user('Same'))]
    const { terminal, record } = finish(fixture, extra, status)
    const restored = applyAgentRunRecord(fixture.state, record)
    assert.equal(restored.state, 'settled'); assert.equal(restored.rounds, 1)
    assert.deepEqual(restored.runUsage, fixture.state.runUsage)
    assert.deepEqual(restored.session, projectAgentRecords('session', [
      { version: 1, sessionId: 'session', eventId: 'legacy', sequence: 1, previousEventId: null, source,
        type: 'session_snapshot', reason: 'legacy_import', snapshot: { history: fixture.base.history, outcomes: [], usage: zero } }, terminal
    ]))
    assert.deepEqual(restored.history.slice(-2).map(item => item.id), ['unseen-one', 'unseen-two'])
  }
})

test('terminal unseen users may precede a new assistant but cannot introduce initial/system input or split tools', () => {
  const fixture = start(); accept(fixture, assistant('Answer'))
  const { record } = finish(fixture, [entry('unseen-user', user('Continue')), entry('unseen-assistant', assistant('New answer'))], 'completed')
  assert.equal(applyAgentRunRecord(fixture.state, record).rounds, 2)
  const first = start()
  assert.throws(() => settlement(first, [entry('initial-in-suffix', user('Initial'))]), /new user\/system/)
  assert.throws(() => settlement(fixture, [entry('system-in-suffix', { kind: 'message', role: 'system', content: 'System' })]), /new user\/system/)
  const tools = start(), call = { id: 'pending', name: 'tool', arguments: {} }
  accept(tools, assistant('Calling', [call]))
  assert.throws(() => settlement(tools, [entry('splitting-user', user('Interrupt')), entry('closure', result(call))]), /unanswered tool calls/)
  const valid = finish(tools, [entry('closure', result(call)), entry('after-closure', user('Next request'))])
  assert.equal(applyAgentRunRecord(tools.state, valid.record).rounds, 1)
  const raw = structuredClone(valid.terminal)
  raw.snapshot.history.splice(-2, 2, raw.snapshot.history.at(-1), raw.snapshot.history.at(-2))
  assert.throws(() => decodeAgentRecord(raw))
})

test('completed terminals reject a trailing admitted user and preserve text-only transition safety', () => {
  const fixture = start(); accept(fixture, assistant('Answer')); accept(fixture, user('Awaiting the next round'))
  assert.throws(() => settlement(fixture, [], 'completed'), /text-only final/)
  const cancelled = finish(fixture)
  const changed = structuredClone(cancelled.record); changed.terminal.settlement.status = 'completed'
  assert.throws(() => decodeAgentRecord(changed.terminal), /text-only final/)
  assert.throws(() => applyAgentRunRecord(fixture.state, changed), /text-only final/)
  assert.equal(applyAgentRunRecord(fixture.state, cancelled.record).state, 'settled')
  const invalid = start()
  assert.throws(() => settlement(invalid, [entry('text-one', assistant('One')), entry('text-two', assistant('Two')),
    entry('late-user', user('Too late to justify prior continuation'))]), /text-only/)
  // v1 session records without steering retain their existing decoder semantics.
  const legacy = settlement(invalid, [entry('legacy-one', assistant('One')), entry('legacy-two', assistant('Two'))])
  assert.equal(decodeAgentRecord(legacy).settlement.rounds, 2)
  assert.throws(() => applyAgentRunRecord(invalid.state, createAgentRunTerminal(header(invalid.state), legacy)), /text-only/)
})

test('accepted user identities, payloads, FIFO order and provenance cannot be rewritten at settlement', () => {
  const fixture = start(); accept(fixture, assistant('Ready'))
  const one = accept(fixture, user('Same'), { id: 'one' }); accept(fixture, user('Same'), { id: 'two' })
  const { record } = finish(fixture)
  for (const mutate of [
    item => { item.id = 'replacement' },
    item => { item.message.content = 'Rewritten' },
    item => { item.source.reference = 'other-source' },
    item => { item.source.revision = '2' }
  ]) {
    const changed = structuredClone(record); mutate(changed.terminal.snapshot.history.find(item => item.id === 'one'))
    assert.throws(() => applyAgentRunRecord(fixture.state, changed), /identity\/order|payload\/provenance/)
  }
  const reversed = structuredClone(record); reversed.terminal.snapshot.history.splice(-2, 2,
    reversed.terminal.snapshot.history.at(-1), reversed.terminal.snapshot.history.at(-2))
  assert.throws(() => applyAgentRunRecord(fixture.state, reversed), /identity\/order/)
  const changedDuplicate = structuredClone(one); changedDuplicate.entry.source.revision = '2'
  assert.throws(() => applyAgentRunRecord(fixture.state, changedDuplicate), /Conflicting duplicate/)
  assert.throws(() => applyAgentRunRecord(fixture.state, accepted(fixture, user('Duplicate ID'), { id: 'one' })), /identity\/count/)
})

test('runAgent accepted user hook failure preserves its full admitted batch for terminal recovery', async () => {
  const messages = [user('Initial')], updates = []
  const outcome = await runAgent({ messages, tools: [], maxRounds: 2,
    provider: { async generate() { return { content: 'First answer', toolCalls: [], usage: { inputTokens: 3, outputTokens: 2, totalTokens: 6 } } } },
    async executeTool() { throw Error('No tools') },
    getSteeringMessages() { return [user('Same'), user('Same')] },
    onAccepted(update) { updates.push(update); if (update.type === 'user_message_accepted') throw Error('Hook failure') }
  })
  assert.equal(outcome.status, 'error'); assert.equal(outcome.error.code, 'event_error')
  assert.equal(outcome.rounds, 1)
  const base = createAgentProjection('session'), waiting = createAgentRunProjection(base, 'run')
  const first = createAgentRunStart(header(waiting), base, [entry('initial', messages[0])])
  let state = applyAgentRunRecord(waiting, first)
  const observed = createAgentAcceptedRecord({ envelope: header(state), update: updates[0], historyId: 'answer', source })
  state = applyAgentRunRecord(state, observed)
  const history = outcome.history.map((message, index) => index < 2 ? state.history[index] : entry(`unseen-${index}`, message))
  const terminal = createRunSettlement({ envelope: { version: 1, sessionId: 'session', eventId: 'terminal', sequence: 1,
    previousEventId: null, source }, runId: 'run', inputHistoryLength: messages.length, result: outcome, history,
    outcomes: [], sessionUsage: outcome.usage })
  const record = createAgentRunTerminal(header(state), terminal)
  const restored = applyAgentRunRecord(state, record)
  assert.deepEqual(restored.history.map(item => item.message), outcome.history)
  assert.deepEqual(restored.runUsage, outcome.usage)
  assert.equal(restored.rounds, 1)
})
