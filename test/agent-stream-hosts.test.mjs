// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  agentArgumentsDigest, agentEvidenceDigest, decodeAgentRecord, projectAgentRecords
} from '../dist/events.js'
import {
  applyAgentRunRecord, createAgentRunProjection, decodeAgentRunRecord, projectAgentRunRecords
} from '../dist/events/stream.js'
import {
  FINAL_USAGE, HOST_KINDS, LEGACY_HISTORY, LEGACY_USAGE, OfflineStreamHostAdapter,
  POISON, ROUND_USAGE, SESSION_ID, STREAM_CORPUS, StreamCursorView, gate, hostMetadata
} from './fixtures/agent-stream-hosts.mjs'

// Same offline corpus, independently owned CLI file-rename/Desktop transaction
// seams. No imports of production hosts, native app, server, SDK, or credentials.
// This proves ordered accepted deltas and host persistence/publication behavior;
// it does not assert CLI-20/Desktop-14 adoption or completed native assessment.
const clone = value => structuredClone(value)
const combined = {
  inputTokens: ROUND_USAGE.inputTokens + FINAL_USAGE.inputTokens,
  outputTokens: ROUND_USAGE.outputTokens + FINAL_USAGE.outputTokens,
  totalTokens: ROUND_USAGE.totalTokens + FINAL_USAGE.totalTokens,
  cachedInputTokens: ROUND_USAGE.cachedInputTokens + FINAL_USAGE.cachedInputTokens
}
const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
const expected = {
  success: ['completed', 2, combined, ['succeeded', 'confirmed'], 1, 1],
  denied: ['completed', 2, combined, ['denied', 'not_attempted'], 0, 1],
  failed_confirmed: ['completed', 2, combined, ['failed', 'confirmed'], 1, 1],
  cancel_no_send: ['cancelled', 1, ROUND_USAGE, ['cancelled', 'not_attempted'], 0, 0],
  cancel_unknown: ['cancelled', 1, ROUND_USAGE, ['cancelled', 'unknown'], 1, 1],
  partial_stream: ['error', 0, zero, null, 0, 0, 'provider_error'],
  hook_failure: ['error', 1, ROUND_USAGE, null, 0, 0, 'event_error'],
  assistant_hook_failure: ['error', 1, ROUND_USAGE, null, 0, 0, 'event_error'],
  result_hook_failure: ['error', 1, ROUND_USAGE, ['succeeded', 'confirmed'], 1, 1, 'event_error'],
  late_callback: ['cancelled', 1, ROUND_USAGE, null, 0, 0],
  late_provider: ['cancelled', 0, zero, null, 0, 0]
}

function assertReplay(host, runId) {
  const stored = host.storage.read(), retained = stored.runs[runId]
  const base = projectAgentRecords(SESSION_ID, JSON.parse(JSON.stringify(retained.baseJournal)))
  const records = JSON.parse(JSON.stringify(retained.records))
  const full = projectAgentRunRecords(base, runId, records)
  const incremental = records.reduce((cursor, record) => applyAgentRunRecord(cursor, record), createAgentRunProjection(base, runId))
  assert.deepEqual(full, incremental)
  assert.deepEqual(full, host.active)
  if (full.state === 'settled') assert.deepEqual(full.session, host.committed)
  const restored = new OfflineStreamHostAdapter(host.kind, host.storage)
  const view = restored.restore(runId)
  assert.deepEqual(view.run, full)
  assert.equal(view.incomplete, full.state !== 'settled')
  assert.equal(view.approvalRestored, false)
  assert.equal(restored.validatedRevision, null)
  assert.deepEqual(restored.counters, { providers: 0, tools: 0, servers: 0, approvals: 0, policyChecks: 0, lateResultsIgnored: 0, lateCallbacksIgnored: 0 })
  assert.deepEqual(restored.acknowledgements, [])
  assert.deepEqual(host.storage.read(), stored, 'Reload is strictly read-only')
  return full
}

for (const scenario of STREAM_CORPUS) test(`paired ordered stream ${scenario} reconciles complete terminal and identical replay`, async () => {
  const paired = []
  for (const kind of HOST_KINDS) {
    const host = new OfflineStreamHostAdapter(kind)
    await host.initialize()
    const document = clone(host.storage.read().document), base = host.committed
    const { result, record, terminal, events, hookCursors, releaseLate } = await host.runCase(scenario)
    const [status, rounds, usage, evidencePair, servers, approvals, error] = expected[scenario]
    assert.equal(result.status, status); assert.equal(result.rounds, rounds); assert.deepEqual(result.usage, usage)
    assert.equal(result.error?.code, error)
    assert.equal(host.counters.servers, servers); assert.equal(host.counters.approvals, approvals)
    const chain = host.storage.read().runs[`${scenario}-run`].records
    assert.equal(chain[0].type, 'run_started')
    assert.deepEqual([chain[0].baseSequence, chain[0].baseEventId, chain[0].baseReceiptDigest],
      [base.sequence, base.eventId, base.receipts.at(-1).digest])
    assert.equal(chain[0].input.length, 1)
    assert.equal(chain[0].input[0].message.role, 'user')
    assert.equal(record.type, 'run_settled'); assert.equal(chain.at(-1).eventId, record.eventId)
    assert.deepEqual(chain.map(item => item.sequence), chain.map((_item, index) => index + 1))
    assert.ok(chain.every(item => item.scope === 'run' && item.runId === `${scenario}-run`))
    assert.equal(terminal.sequence, base.sequence + 1)
    assert.equal(terminal.previousEventId, base.eventId)
    assert.equal(host.committed.sequence, 2, 'Session order advances exactly once, independently of run delta count')
    assert.deepEqual(host.storage.read().journal.map(item => item.type), ['session_snapshot', 'run_settled'])
    assert.equal(terminal.inputHistoryLength, LEGACY_HISTORY.length + 1)
    assert.deepEqual(terminal.snapshot.history.map(item => item.message), result.history)
    assert.deepEqual(terminal.snapshot.history.slice(0, LEGACY_HISTORY.length), LEGACY_HISTORY)
    assert.deepEqual(hostMetadata(kind, host.storage.read().document), hostMetadata(kind, document))
    assert.deepEqual(base.runs, []); assert.deepEqual(base.callBindings, [], 'No historical run identities are invented')
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) assert.equal(host.committed.usage[key], LEGACY_USAGE[key] + usage[key])
    assert.ok(hookCursors.every(item => item.sessionSequence === base.sequence))
    assert.ok(hookCursors.filter(item => item.type === 'assistant').every(item => item.runSequence >= 2), 'Canonical acceptance precedes legacy assistant events')
    assert.ok(hookCursors.filter(item => item.type === 'tool_completed').every(item => item.runSequence >= 3), 'Canonical result precedes legacy completion events')
    const accepted = chain.filter(item => item.type === 'assistant_accepted')
    assert.equal(accepted.length, rounds)
    if (rounds) {
      assert.deepEqual(accepted[0].usage, ROUND_USAGE)
      assert.deepEqual(accepted[0].aggregateUsage, ROUND_USAGE)
      assert.deepEqual(accepted.at(-1).aggregateUsage, result.usage)
    }
    if (evidencePair) {
      const evidence = terminal.snapshot.outcomes.at(-1)
      assert.deepEqual([evidence.status, evidence.effect], evidencePair)
      assert.equal(evidence.runId, `${scenario}-run`)
      const call = result.history.flatMap(item => item.kind === 'assistant' ? item.toolCalls : []).find(item => item.id === evidence.callId)
      assert.equal(evidence.name, call.name); assert.equal(evidence.argumentsDigest, agentArgumentsDigest(call.arguments))
      assert.deepEqual(host.acknowledgements, [{ eventId: terminal.eventId, sequence: terminal.sequence, evidenceDigest: agentEvidenceDigest(evidence), evidence }])
      assert.ok(host.storage.trace.indexOf(`ack:${terminal.eventId}:${evidence.callId}`) > host.storage.trace.lastIndexOf(`${kind === 'CLI' ? 'session-file-rename' : 'session-transaction'}:committed`))
    } else assert.deepEqual(terminal.snapshot.outcomes, [], 'Generic closures/live events supply no delivery proof')
    if (['hook_failure', 'assistant_hook_failure'].includes(scenario)) {
      assert.deepEqual(result.usage, ROUND_USAGE)
      assert.equal(JSON.parse(result.history.at(-1).content).error.code, 'run_failed')
      assert.equal(chain.filter(item => item.type === 'tool_result_accepted').length, 0, 'Cleanup closes pending calls only in the authoritative terminal')
      assert.equal(events.includes('tool_started'), false)
    }
    if (scenario === 'result_hook_failure') {
      assert.equal(chain.filter(item => item.type === 'tool_result_accepted').length, 1)
      assert.equal(events.includes('tool_completed'), false)
      assert.equal(result.history.at(-1).content, 'Owned confirmed success')
    }
    if (scenario === 'partial_stream' || scenario === 'late_provider') {
      assert.equal(accepted.length, 0)
      assert.ok(host.liveProgress.join('').includes('display-only'))
      assert.equal(JSON.stringify(host.storage.read()).includes('display-only'), false)
    }
    const durable = host.storage.read(), cursor = host.active, pubs = host.published.length, acks = clone(host.acknowledgements)
    await releaseLate()
    assert.deepEqual(host.storage.read(), durable); assert.equal(host.active, cursor)
    assert.equal(host.published.length, pubs); assert.deepEqual(host.acknowledgements, acks)
    assert.equal(host.liveProgress.join('').includes('obsolete callback progress'), false)
    if (scenario === 'cancel_unknown') assert.equal(host.counters.lateResultsIgnored, 1)
    if (scenario === 'late_callback') assert.equal(host.counters.lateCallbacksIgnored, 1)
    paired.push(assertReplay(host, `${scenario}-run`))
  }
  assert.deepEqual(paired[0], paired[1])
})

for (const kind of HOST_KINDS) {
  test(`${kind} same corpus has run-local order and stable original identities across one session`, async () => {
    const host = new OfflineStreamHostAdapter(kind); await host.initialize()
    for (const scenario of STREAM_CORPUS) {
      const base = host.committed
      const { terminal, releaseLate } = await host.runCase(scenario)
      assert.equal(terminal.sequence, base.sequence + 1)
      assert.deepEqual(terminal.snapshot.history.slice(0, base.history.length), base.history)
      await releaseLate(); assertReplay(host, `${scenario}-run`)
    }
    assert.equal(host.committed.runs.length, STREAM_CORPUS.length)
    assert.deepEqual(host.committed.history.slice(0, LEGACY_HISTORY.length), LEGACY_HISTORY)
    assert.equal(Object.keys(host.storage.read().runs).length, STREAM_CORPUS.length)
  })

  test(`${kind} active reload is explicitly incomplete with exact observed usage and no invented closure, round, or approval`, async () => {
    const host = new OfflineStreamHostAdapter(kind); await host.initialize()
    const prepared = await host.runCase('success', { checkpoint: false })
    const restored = new OfflineStreamHostAdapter(kind, host.storage)
    const view = restored.restore('success-run')
    assert.equal(view.run.state, 'running'); assert.equal(view.incomplete, true)
    assert.equal(view.session.runs.length, 0); assert.deepEqual(view.session.usage, LEGACY_USAGE)
    assert.equal(view.run.rounds, 2); assert.deepEqual(view.run.runUsage, combined)
    assert.deepEqual(view.run.history.map(item => item.message), prepared.result.history)
    assert.equal(view.approvalRestored, false); assert.equal(restored.counters.policyChecks, 0)
    await assert.rejects(restored.revalidatePolicy('policy-stale'), /revalidated/)
    assert.equal(restored.counters.providers + restored.counters.tools + restored.counters.servers + restored.counters.approvals, 0)
    await assert.rejects(restored.runCase('denied'), /automatically resume/)
    assert.equal(restored.counters.providers, 0)
    assertReplay(host, 'success-run')
  })

  test(`${kind} zero-round and omitted first/final cache counts preserve independent authoritative totals`, async () => {
    const host = new OfflineStreamHostAdapter(kind); await host.initialize()
    await host.runCase('partial_stream')
    assert.equal(host.committed.usage.cachedInputTokens, LEGACY_USAGE.cachedInputTokens)
    const first = await host.runCase('success', { omitFirstRoundCache: true })
    assert.equal(Object.hasOwn(host.storage.read().runs['success-run'].records[1].usage, 'cachedInputTokens'), false)
    assert.equal(Object.hasOwn(first.result.usage, 'cachedInputTokens'), false)
    assert.equal(Object.hasOwn(host.committed.usage, 'cachedInputTokens'), false)
    const final = await host.runCase('denied', { omitFinalRoundCache: true })
    assert.equal(host.storage.read().runs['denied-run'].records[1].aggregateUsage.cachedInputTokens, ROUND_USAGE.cachedInputTokens)
    assert.equal(Object.hasOwn(final.result.usage, 'cachedInputTokens'), false)
    assert.equal(final.result.usage.totalTokens, combined.totalTokens)
    assert.notEqual(final.result.usage.totalTokens, final.result.usage.inputTokens + final.result.usage.outputTokens)
    const known = await host.runCase('failed_confirmed')
    assert.equal(known.result.usage.cachedInputTokens, combined.cachedInputTokens)
    assert.equal(Object.hasOwn(host.committed.usage, 'cachedInputTokens'), false, 'Later reported rounds cannot fill an older unknown aggregate')
  })

  for (const failure of ['before', 'after_unreadable']) test(`${kind} ${failure} terminal checkpoint retains old cursor and sidecar until exact retry without redispatch`, async () => {
    const host = new OfflineStreamHostAdapter(kind); await host.initialize()
    const { record } = await host.runCase('success', { checkpoint: false })
    const run = host.active, session = host.committed, durable = host.storage.read(), counters = clone(host.counters)
    host.storage.failNext = failure
    await assert.rejects(host.appendRunRecord(record), /checkpoint failed/)
    assert.equal(host.active, run); assert.equal(host.committed, session)
    assert.deepEqual(host.acknowledgements, []); assert.equal(host.sidecar.get('success-call').effect, 'confirmed')
    assert.equal(host.pending.record.eventId, record.eventId)
    if (failure === 'before') assert.deepEqual(host.storage.read(), durable)
    else assert.equal(host.storage.read().journal.length, durable.journal.length + 1)
    const bytes = host.storage.attempts.at(-1), count = host.storage.attempts.length
    await assert.rejects(host.appendRunRecord(record), /exact pending checkpoint/)
    await host.retryCheckpoint()
    assert.deepEqual(host.counters, counters)
    assert.equal(host.storage.attempts.at(-1), bytes)
    assert.equal(host.storage.attempts.length, failure === 'before' ? count + 1 : count, 'Ambiguous committed bytes are verified without another durable append')
    assert.equal(host.active.state, 'settled'); assert.equal(host.committed.sequence, 2)
    assert.equal(host.acknowledgements.length, 1)
    assertReplay(host, 'success-run')
  })

  test(`${kind} failure after durable accepted write is recovered by exact readback before next dispatch`, async () => {
    const host = new OfflineStreamHostAdapter(kind); await host.initialize()
    await host.start('manual-run', [{ id: 'manual-input', source: { reference: 'fixture://input' }, message: { kind: 'message', role: 'user', content: 'manual request' } }])
    const record = host.prepareAccepted({ type: 'assistant_accepted', round: 1,
      message: { kind: 'assistant', content: 'accepted manual answer', toolCalls: [] }, usage: ROUND_USAGE, aggregateUsage: ROUND_USAGE })
    host.storage.failNext = 'after'
    await host.appendRunRecord(record)
    assert.equal(host.pending, null); assert.equal(host.active.sequence, 2)
    assert.deepEqual(host.active.runUsage, ROUND_USAGE)
    assert.deepEqual(host.acknowledgements, [], 'Accepted history durability is separate from delivery acknowledgement')
    const attempts = host.storage.attempts.length, cursor = host.active
    await host.appendRunRecord(record)
    assert.equal(host.active, cursor); assert.equal(host.storage.attempts.length, attempts)
    assertReplay(host, 'manual-run')
  })

  for (const failure of ['before', 'after_unreadable']) test(`${kind} accepted ${failure} checkpoint preserves old run cursor and exact observed usage for retry`, async () => {
    const host = new OfflineStreamHostAdapter(kind); await host.initialize()
    await host.start('pending-run', [{ id: 'pending-input', source: { reference: 'fixture://input' }, message: { kind: 'message', role: 'user', content: 'pending request' } }])
    const record = host.prepareAccepted({ type: 'assistant_accepted', round: 1,
      message: { kind: 'assistant', content: 'pending answer', toolCalls: [{ id: 'pending-call', name: 'offline_fixture', arguments: {} }] },
      usage: ROUND_USAGE, aggregateUsage: ROUND_USAGE })
    const previous = host.active, counters = clone(host.counters), pubs = host.published.length
    host.storage.failNext = failure
    await assert.rejects(host.appendRunRecord(record), /checkpoint failed/)
    assert.equal(host.active, previous); assert.equal(host.active.sequence, 1)
    assert.equal(host.published.length, pubs)
    assert.deepEqual(host.pending.run.runUsage, ROUND_USAGE, 'Accepted usage survives uncertain persistence without advancing the committed view')
    assert.equal(host.pending.run.history.at(-1).id, record.entry.id)
    const bytes = host.storage.attempts.at(-1)
    await host.retryCheckpoint()
    assert.equal(host.storage.attempts.at(-1), bytes)
    assert.deepEqual(host.counters, counters, 'Retry never invokes a provider, tool, approval, or server')
    assert.equal(host.active.sequence, 2); assert.deepEqual(host.active.runUsage, ROUND_USAGE)
    assert.deepEqual(host.acknowledgements, [])
    assertReplay(host, 'pending-run')
  })

  for (const resultWrite of [false, true]) test(`${kind} admitted ${resultWrite ? 'result refinement' : 'assistant'} write drains after cancellation before terminal checkpoint`, async () => {
    const host = new OfflineStreamHostAdapter(kind); await host.initialize()
    const writeGate = gate(), returnedGate = gate()
    const scenario = resultWrite ? 'cancel_admitted_result' : 'cancel_admitted_write'
    const running = host.runCase(scenario, { writeGate, returnedGate, refineAfterCancel: resultWrite, checkpoint: false })
    const raw = await returnedGate.promise
    assert.equal(raw.status, 'cancelled'); assert.equal(raw.rounds, 1); assert.deepEqual(raw.usage, ROUND_USAGE)
    assert.equal(host.committed.sequence, 1)
    assert.equal(host.storage.read().journal.length, 1)
    assert.equal(host.storage.read().runs[`${scenario}-run`].records.at(-1).type, resultWrite ? 'assistant_accepted' : 'run_started')
    assert.deepEqual(host.acknowledgements, [])
    writeGate.resolve()
    const prepared = await running
    assert.equal(host.storage.read().runs[`${scenario}-run`].records.at(-1).type, resultWrite ? 'tool_result_accepted' : 'assistant_accepted')
    assert.deepEqual(prepared.terminal.settlement.usage, ROUND_USAGE)
    if (resultWrite) {
      assert.equal(raw.history.at(-1).content, 'Owned unconfirmed generic result')
      assert.equal(prepared.result.history.at(-1).content, 'Owned independently confirmed server success')
      assert.equal(prepared.terminal.snapshot.outcomes[0].effect, 'confirmed')
      assert.equal(host.sidecar.get(`${scenario}-call`).effect, 'confirmed')
      assert.equal(Object.hasOwn(prepared.terminal.snapshot.outcomes[0], 'supersedes'), false, 'No durable earlier sidecar receipt was invented')
      host.storage.failNext = 'before'
      await assert.rejects(host.appendRunRecord(prepared.record), /checkpoint failed/)
      assert.deepEqual(host.acknowledgements, [], 'Stronger drained sidecar waits for verified terminal bytes')
      await host.retryCheckpoint()
    } else await host.appendRunRecord(prepared.record)
    const drainIndex = host.storage.trace.indexOf(`drained:${scenario}-run`)
    assert.ok(host.storage.trace.lastIndexOf(`${kind === 'CLI' ? 'session-file-rename' : 'session-transaction'}:committed`) > drainIndex)
    assert.equal(host.active.state, 'settled')
    assertReplay(host, `${scenario}-run`)
  })

  test(`${kind} subscription-before-list discards delayed snapshots by independent session and run watermarks`, async () => {
    const host = new OfflineStreamHostAdapter(kind); await host.initialize()
    await host.start('cursor-run', [{ id: 'cursor-input', source: { reference: 'fixture://input' }, message: { kind: 'message', role: 'user', content: 'cursor request' } }])
    const view = new StreamCursorView(host), oldRun = host.view(), delayedRun = gate()
    view.receive(oldRun)
    const runResponse = delayedRun.promise.then(() => view.receive(oldRun))
    await host.appendRunRecord(host.prepareAccepted({ type: 'assistant_accepted', round: 1,
      message: { kind: 'assistant', content: 'cursor answer', toolCalls: [] }, usage: ROUND_USAGE, aggregateUsage: ROUND_USAGE }))
    const current = view.value
    delayedRun.resolve(); assert.equal(await runResponse, false); assert.equal(view.rejectedRun, 1)
    assert.equal(view.value, current)
    const oldSession = host.view(), delayedSession = gate()
    const sessionResponse = delayedSession.promise.then(() => view.receive(oldSession))
    const history = clone(host.committed.history)
    history[0].message.content = '[redacted]'; history[0].source.revision = 'privacy-2'
    await host.commitSession(decodeAgentRecord({ ...host.sessionEnvelope('fixture://privacy'), type: 'session_snapshot', reason: 'privacy',
      snapshot: { history, outcomes: [], usage: host.committed.usage } }))
    const latest = view.value
    assert.equal(latest.run, null); assert.equal(latest.session.history[0].message.content, '[redacted]')
    delayedSession.resolve(); assert.equal(await sessionResponse, false); assert.equal(view.rejectedSession, 1)
    assert.equal(view.value, latest)
    assert.equal(host.quarantined.at(-1).runId, 'cursor-run')
    const restoring = new OfflineStreamHostAdapter(kind, host.storage)
    const restored = restoring.restore('cursor-run')
    assert.equal(restored.run, null); assert.equal(restored.incomplete, false)
    assert.equal(JSON.stringify(restoring.published).includes('existing request'), false, 'Stale active history is quarantined before publication')
    assert.equal(restoring.quarantined.length, 1)
    assert.equal(restoring.counters.providers + restoring.counters.tools + restoring.counters.servers + restoring.counters.approvals, 0)
    view.unsubscribe()
  })

  test(`${kind} newer reconciliation cursor also quarantines an incomplete run without restoring approval`, async () => {
    const host = new OfflineStreamHostAdapter(kind); await host.initialize()
    await host.runCase('success', { checkpoint: false })
    await host.commitSession(decodeAgentRecord({ ...host.sessionEnvelope('fixture://reconciliation'), type: 'session_snapshot', reason: 'reconciliation',
      snapshot: { history: host.committed.history, outcomes: host.committed.outcomes, usage: host.committed.usage } }))
    const restoring = new OfflineStreamHostAdapter(kind, host.storage)
    assert.equal(restoring.restore('success-run').run, null)
    assert.deepEqual(restoring.quarantined, [{ runId: 'success-run', reason: 'superseded-session-watermark' }])
    assert.equal(restoring.validatedRevision, null)
  })

  for (const race of ['before admission', 'after admission CAS', 'after durable write readback']) test(`${kind} two adapters ${race} cannot overwrite or republish a newer shared privacy anchor`, async () => {
    const first = new OfflineStreamHostAdapter(kind); await first.initialize()
    await first.start('shared-run', [{ id: 'shared-input', source: { reference: 'fixture://input' },
      message: { kind: 'message', role: 'user', content: 'shared request' } }])
    const record = first.prepareAccepted({ type: 'assistant_accepted', round: 1,
      message: { kind: 'assistant', content: 'old-base accepted answer', toolCalls: [] }, usage: ROUND_USAGE, aggregateUsage: ROUND_USAGE })
    const second = new OfflineStreamHostAdapter(kind, first.storage); second.restore()
    const history = clone(second.committed.history)
    history[0].message.content = '[redacted]'; history[0].source.revision = 'privacy-shared-2'
    const privacy = decodeAgentRecord({ ...second.sessionEnvelope('fixture://shared-privacy'), type: 'session_snapshot', reason: 'privacy',
      snapshot: { history, outcomes: [], usage: second.committed.usage } })
    const pubs = first.published.length, counters = clone(first.counters)
    let writing
    if (race === 'before admission') {
      await second.commitSession(privacy)
      writing = first.appendRunRecord(record)
    } else {
      const admitted = gate(), release = gate()
      const hook = async () => { admitted.resolve(); await release.promise }
      if (race === 'after admission CAS') first.storage.beforeCheckpoint = hook
      else first.storage.afterCheckpoint = hook
      writing = first.appendRunRecord(record)
      await admitted.promise
      await second.commitSession(privacy)
      release.resolve()
    }
    await assert.rejects(writing, /obsolete|CAS conflict/)
    const stored = first.storage.read()
    assert.equal(stored.journal.length, 2)
    assert.equal(stored.journal.at(-1).reason, 'privacy')
    assert.equal(stored.document[first.kind === 'CLI' ? 'messages' : 'transcript'][0].message.content, '[redacted]')
    assert.equal(first.active, null); assert.equal(first.pending, null)
    assert.equal(first.committed.sequence, 2); assert.equal(first.committed.history[0].message.content, '[redacted]')
    assert.equal(first.quarantined.at(-1).runId, 'shared-run')
    assert.deepEqual(first.counters, counters)
    assert.deepEqual(first.acknowledgements, [])
    assert.equal(JSON.stringify(first.published.slice(pubs)).includes('existing request'), false)
    assert.equal(JSON.stringify(first.published.slice(pubs)).includes('old-base accepted answer'), false)
    const chain = stored.runs['shared-run'].records
    assert.equal(chain.length, race === 'after durable write readback' ? 2 : 1,
      'CAS blocks stale writes; a write already durable before privacy is retained only as a quarantined historical chain')
    const restoring = new OfflineStreamHostAdapter(kind, first.storage)
    assert.equal(restoring.restore('shared-run').run, null)
    assert.equal(JSON.stringify(restoring.published).includes('existing request'), false)
  })

  for (const position of ['earlier', 'latest']) for (const action of ['admission', 'publication']) test(`${kind} same-cursor different ${position} accepted bytes are quarantined before ${action}`, async () => {
    const host = new OfflineStreamHostAdapter(kind); await host.initialize()
    const prepared = await host.runCase('success', { checkpoint: false })
    const cursor = host.active, stored = host.storage.read(), chain = stored.runs['success-run'].records
    const target = position === 'earlier' ? chain[1] : chain.at(-1)
    assert.equal(target.type, 'assistant_accepted')
    target.entry.message.content = 'divergent same-cursor accepted bytes'
    // The forged chain remains structurally valid and has exactly the same
    // sequence/event IDs. Only validated payload/receipt comparison catches it.
    const divergent = projectAgentRunRecords(host.committed, 'success-run', chain)
    assert.equal(divergent.sequence, cursor.sequence); assert.equal(divergent.eventId, cursor.eventId)
    assert.notDeepEqual(divergent, cursor)
    if (position === 'earlier') assert.equal(divergent.receipts.at(-1).digest, cursor.receipts.at(-1).digest,
      'Last receipt alone cannot detect a divergent earlier accepted envelope')
    else assert.notEqual(divergent.receipts.at(-1).digest, cursor.receipts.at(-1).digest)
    host.storage.durable = stored // Owned same-cursor corruption injection.
    const pubs = host.published.length, attempts = host.storage.attempts.length, counters = clone(host.counters)
    if (action === 'admission') await assert.rejects(host.appendRunRecord(prepared.record), /obsolete/)
    else assert.throws(() => host.publish(), /obsolete/)
    assert.equal(host.active, null); assert.equal(host.pending, null)
    assert.equal(host.committed.sequence, 1)
    assert.equal(host.quarantined.at(-1).runId, 'success-run')
    assert.equal(host.storage.attempts.length, attempts)
    assert.deepEqual(host.storage.read(), stored)
    assert.deepEqual(host.counters, counters); assert.deepEqual(host.acknowledgements, [])
    assert.equal(JSON.stringify(host.published.slice(pubs)).includes('divergent same-cursor accepted bytes'), false)
    assert.equal(JSON.stringify(host.published.slice(pubs)).includes('accepted fixture'), false)
  })

  for (const location of ['envelope', 'entry provenance', 'nested provider state', 'terminal-only error', 'outcome source']) test(`${kind} complete stream ${location} privacy screening precedes checkpoint and reload publication`, async () => {
    const host = new OfflineStreamHostAdapter(kind); await host.initialize()
    const prepared = await host.runCase('success', { checkpoint: false })
    const record = clone(prepared.record)
    if (location === 'envelope') record.source.reference = `fixture://${POISON}`
    if (location === 'entry provenance') record.terminal.snapshot.history[LEGACY_HISTORY.length + 1].source.reference = `fixture://${POISON}`
    if (location === 'nested provider state') record.terminal.snapshot.history[LEGACY_HISTORY.length + 1].message.providerState.items.push({ nested: { token: POISON } })
    if (location === 'terminal-only error') { record.terminal.settlement.status = 'error'; record.terminal.settlement.error = { code: 'event_error', message: POISON } }
    if (location === 'outcome source') record.terminal.snapshot.outcomes[0].source.reference = `fixture://${POISON}`
    decodeAgentRunRecord(record)
    const durable = host.storage.read(), cursor = host.active, pubs = host.published.length
    await assert.rejects(host.appendRunRecord(record), /privacy screen/)
    assert.equal(host.pending, null); assert.equal(host.active, cursor)
    assert.deepEqual(host.storage.read(), durable); assert.equal(host.published.length, pubs)
    assert.deepEqual(host.acknowledgements, [])
    // Valid accepted envelope poison is screened independently of terminal
    // prefix checks, including fields the renderer never displays.
    const stored = host.storage.read()
    const accepted = stored.runs['success-run'].records[1]
    accepted.source.reference = `fixture://${POISON}`
    host.storage.durable = stored
    const restoring = new OfflineStreamHostAdapter(kind, host.storage)
    assert.throws(() => restoring.restore('success-run'), /privacy screen/)
    assert.equal(restoring.committed.sequence, 0); assert.equal(restoring.active, null)
    assert.deepEqual(restoring.published, [])
  })
}
