// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAgentProjection, decodeAgentRecord, createRunSettlement,
  projectAgentRecords, applyAgentRecord, agentArgumentsDigest, agentEvidenceDigest
} from '../dist/events.js'
import {
  createAgentRunProjection, createAgentRunStart, createAgentAcceptedRecord,
  createAgentRunTerminal, decodeAgentRunRecord, applyAgentRunRecord, projectAgentRunRecords
} from '../dist/events/stream.js'

const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
const source = { reference: 'host/image-session', revision: '1' }
const image = { id: 'snapshot-1', sha256: 'a'.repeat(64), mimeType: 'image/png', width: 20, height: 30, byteLength: 100 }
const call = { id: 'read-1', name: 'read_image', arguments: { path: 'picture.png' } }
const entry = (id, message) => ({ id, source: structuredClone(source), message: structuredClone(message) })
const imageMessage = () => ({ kind: 'tool_result', callId: call.id, name: call.name, content: 'Read image snapshot', images: [structuredClone(image)] })
const snapshot = () => ({ version: 2, sessionId: 'session', eventId: 'session-1', sequence: 1, previousEventId: null,
  source, type: 'session_snapshot', reason: 'legacy_import', snapshot: { history: [
    entry('assistant', { kind: 'assistant', content: '', toolCalls: [call] }), entry('image', imageMessage())
  ], outcomes: [], usage: zero } })

function run() {
  const base = createAgentProjection('session')
  let state = createAgentRunProjection(base, 'run')
  const records = []
  const header = () => ({ version: 2, scope: 'run', sessionId: 'session', runId: 'run',
    eventId: `run-${state.sequence + 1}`, sequence: state.sequence + 1, previousEventId: state.eventId, source })
  const append = record => { state = applyAgentRunRecord(state, record); records.push(record); return record }
  append(createAgentRunStart(header(), base, [entry('user', { kind: 'message', role: 'user', content: 'Inspect picture.png' })]))
  const accept = (id, message, round) => append(createAgentAcceptedRecord({ envelope: header(), historyId: id, source,
    update: message.kind === 'assistant'
      ? { type: 'assistant_accepted', round, message, aggregateUsage: zero }
      : { type: 'tool_result_accepted', round, message } }))
  accept('assistant-1', { kind: 'assistant', content: '', toolCalls: [call] }, 1)
  accept('image', imageMessage(), 1)
  accept('assistant-2', { kind: 'assistant', content: 'Observed', toolCalls: [] }, 2)
  const result = { status: 'completed', history: state.history.map(item => item.message), content: 'Observed', rounds: 2, usage: zero }
  const terminal = createRunSettlement({ envelope: { version: 2, sessionId: 'session', eventId: 'session-1', sequence: 1,
    previousEventId: null, source }, runId: 'run', inputHistoryLength: 1, result, history: state.history, outcomes: [], sessionUsage: zero })
  return { base, state, records, terminal, wrapper: createAgentRunTerminal(header(), terminal) }
}

test('v2 session snapshots retain detached frozen image metadata; v1 remains text-only', () => {
  const input = snapshot(), decoded = decodeAgentRecord(input)
  input.snapshot.history[1].message.images[0].id = 'mutated'
  assert.equal(decoded.snapshot.history[1].message.images[0].id, image.id)
  assert(Object.isFrozen(decoded.snapshot.history[1].message.images[0]))
  const old = snapshot(); old.version = 1
  assert.throws(() => decodeAgentRecord(old), /version 2/)
  delete old.snapshot.history[1].message.images
  assert.equal(decodeAgentRecord(old).version, 1)
  old.version = 2
  assert.equal(decodeAgentRecord(old).version, 2)
})

test('v2 standalone accepted tool records validate every image field and reject payload/path extensions', () => {
  const fixture = run(), accepted = fixture.records[2]
  assert.deepEqual(decodeAgentRunRecord(accepted).entry.message.images, [image])
  assert.throws(() => decodeAgentRunRecord({ ...accepted, version: 1 }), /version 2/)
  for (const mutate of [
    ref => { ref.sha256 = 'A'.repeat(64) }, ref => { ref.mimeType = 'image/gif' },
    ref => { ref.width = 0 }, ref => { ref.height = 16_000_001 },
    ref => { ref.byteLength = 5 * 1024 * 1024 + 1 }, ref => { ref.path = '/host/private' },
    ref => { ref.base64 = 'not-canonical' }, ref => { delete ref.id }
  ]) {
    const invalid = structuredClone(accepted); mutate(invalid.entry.message.images[0])
    assert.throws(() => decodeAgentRunRecord(invalid))
  }
  for (const refs of [[], Array(5).fill(image), [image, image]]) {
    const invalid = structuredClone(accepted); invalid.entry.message.images = refs
    assert.throws(() => decodeAgentRunRecord(invalid))
  }
})

test('v2 accepted-image replay and terminal snapshot converge without base64 or manufactured user turns', () => {
  const fixture = run()
  const replay = projectAgentRunRecords(fixture.base, 'run', [...fixture.records, fixture.wrapper])
  const incremental = applyAgentRunRecord(fixture.state, fixture.wrapper)
  assert.deepEqual(replay, incremental)
  assert.equal(replay.state, 'settled')
  assert.deepEqual(replay.history[2].message.images, [image])
  assert.equal(replay.history.filter(item => item.message.kind === 'message').length, 1)
  assert(!JSON.stringify(replay).includes('base64'))
  assert.throws(() => decodeAgentRunRecord({ ...fixture.wrapper, version: 1 }), /downgrade/)
  assert.throws(() => decodeAgentRecord({ ...fixture.terminal, version: 1 }), /version 2/)
})

test('outcome reconciliation cannot replace image observations; explicit privacy may redact them', () => {
  const first = snapshot()
  const evidence = { callId: call.id, runId: 'run', name: call.name, argumentsDigest: agentArgumentsDigest(call.arguments),
    effect: 'unknown', status: 'unknown', source }
  first.snapshot.outcomes = [evidence]
  const state = projectAgentRecords('session', [first])
  const next = structuredClone(first)
  next.eventId = 'session-2'; next.sequence = 2; next.previousEventId = first.eventId; next.reason = 'reconciliation'
  next.snapshot.history[1].source.revision = '2'
  next.snapshot.history[1].message.images[0].sha256 = 'b'.repeat(64)
  next.snapshot.outcomes[0] = { ...evidence, effect: 'confirmed', status: 'succeeded',
    source: { ...source, revision: '2' }, supersedes: agentEvidenceDigest(evidence) }
  assert.throws(() => applyAgentRecord(state, next), /cannot replace image/)
  next.reason = 'privacy'; next.snapshot.outcomes = structuredClone(first.snapshot.outcomes)
  delete next.snapshot.history[1].message.images
  assert.equal(applyAgentRecord(state, next).history[1].message.images, undefined)
})

test('terminal exact-outcome refinement cannot substitute previously accepted image pixels', () => {
  const fixture = run(), terminal = structuredClone(fixture.wrapper)
  terminal.terminal.snapshot.history[2].source.revision = '2'
  terminal.terminal.snapshot.history[2].message.images[0].sha256 = 'b'.repeat(64)
  terminal.terminal.snapshot.outcomes = [{ callId: call.id, runId: 'run', name: call.name,
    argumentsDigest: agentArgumentsDigest(call.arguments), effect: 'confirmed', status: 'succeeded', source }]
  assert.throws(() => applyAgentRunRecord(fixture.state, terminal), /cannot replace image/)
})
