// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AGENT_RECORD_LIMITS, agentArgumentsDigest, agentEvidenceDigest, applyAgentRecord,
  createAgentProjection, decodeAgentRecord, projectAgentRecords
} from '../dist/events.js'
import {
  CORPUS, CursorView, FINAL_USAGE, HOST_KINDS, LEGACY_HISTORY, LEGACY_USAGE,
  OfflineHostAdapter, POISON, ROUND_USAGE, SESSION_ID, gate, hostMetadata, legacyDocument
} from './fixtures/agent-record-hosts.mjs'

// Paired owned adapters only. This is not a CLI-20/Desktop-14 production
// migration, production Svelte fix, or proof of eventstream completeness.
// Sources for the host-owned seams which motivate the fixture boundary:
// CLI: https://github.com/ayayaQ/vivi-cli/tree/2f94b29f4a3a58ba93cde250d64f60258e086407
// Desktop: https://github.com/ayayaQ/bot-commander-desktop/tree/c8b63325b5fbd50b5da2f35ec3c3485815b4dcfb
// These fixtures deliberately contain no imports or unpublished dependencies on
// either host and no services, credentials, native modules, or live MCP servers.
const clone = value => structuredClone(value)
const pair = () => HOST_KINDS.map(kind => new OfflineHostAdapter(kind))
const combinedUsage = {
  inputTokens: ROUND_USAGE.inputTokens + FINAL_USAGE.inputTokens,
  outputTokens: ROUND_USAGE.outputTokens + FINAL_USAGE.outputTokens,
  totalTokens: ROUND_USAGE.totalTokens + FINAL_USAGE.totalTokens,
  cachedInputTokens: ROUND_USAGE.cachedInputTokens + FINAL_USAGE.cachedInputTokens
}
const expected = {
  success: { status: 'completed', rounds: 2, usage: combinedUsage, outcome: ['succeeded', 'confirmed'], servers: 1, approvals: 1 },
  denied: { status: 'completed', rounds: 2, usage: combinedUsage, outcome: ['denied', 'not_attempted'], servers: 0, approvals: 1 },
  failed_confirmed: { status: 'completed', rounds: 2, usage: combinedUsage, outcome: ['failed', 'confirmed'], servers: 1, approvals: 1 },
  cancel_no_send: { status: 'cancelled', rounds: 1, usage: ROUND_USAGE, outcome: ['cancelled', 'not_attempted'], servers: 0, approvals: 0 },
  cancel_unknown: { status: 'cancelled', rounds: 1, usage: ROUND_USAGE, outcome: ['cancelled', 'unknown'], servers: 1, approvals: 1 },
  partial_stream: { status: 'error', rounds: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, outcome: null, servers: 0, approvals: 0, error: 'provider_error' },
  hook_failure: { status: 'error', rounds: 1, usage: ROUND_USAGE, outcome: null, servers: 0, approvals: 0, error: 'event_error' },
  late_callback: { status: 'cancelled', rounds: 1, usage: ROUND_USAGE, outcome: null, servers: 0, approvals: 0 },
  late_provider: { status: 'cancelled', rounds: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, outcome: null, servers: 0, approvals: 0 }
}

function assertReplayPaths(host) {
  const stored = host.storage.read()
  const jsonReload = JSON.parse(JSON.stringify(stored.journal))
  const full = projectAgentRecords(SESSION_ID, jsonReload)
  const incremental = jsonReload.reduce((projection, record) => applyAgentRecord(projection, record), createAgentProjection(SESSION_ID))
  assert.deepEqual(full, incremental)
  assert.deepEqual(full, host.committed)
  const restored = new OfflineHostAdapter(host.kind, host.storage)
  assert.deepEqual(restored.restore(), full)
  assert.equal(restored.published.length, 1)
  assert.deepEqual(restored.counters, { providers: 0, tools: 0, servers: 0, approvals: 0, lateResultsIgnored: 0, lateCallbacksIgnored: 0 })
  assert.deepEqual(restored.acknowledgements, [], 'Replay must not acknowledge, dispatch, invoke a provider/server, or solicit approval')
  assert.equal(host.storage.read().journal.length, stored.journal.length, 'Replay is read-only')
  return full
}

for (const kind of HOST_KINDS) {
  test(`${kind} legacy import preserves source/session/call/message identities and all host metadata without invented evidence`, async () => {
    const host = new OfflineHostAdapter(kind)
    const original = host.storage.read().document
    await host.initialize()
    const stored = host.storage.read(), anchor = stored.journal[0]
    assert.equal(anchor.type, 'session_snapshot')
    assert.equal(anchor.reason, 'legacy_import')
    assert.equal(anchor.sequence, 1)
    assert.equal(anchor.previousEventId, null)
    assert.equal(anchor.sessionId, SESSION_ID)
    assert.deepEqual(anchor.source, hostMetadata(kind, original).source)
    assert.deepEqual(anchor.snapshot.history, LEGACY_HISTORY)
    assert.deepEqual(anchor.snapshot.outcomes, [])
    assert.deepEqual(anchor.snapshot.usage, LEGACY_USAGE)
    assert.deepEqual(host.committed.runs, [])
    assert.deepEqual(host.committed.callBindings, [], 'Historical original run identity is absent, not reconstructed')
    assert.deepEqual(hostMetadata(kind, stored.document), hostMetadata(kind, original))
    assert.deepEqual(stored.document, original, 'The anchor must preserve title, notes, display, validation, and native host schema')
    assert.ok(!('approval' in anchor.snapshot) && !('rounds' in anchor.snapshot) && !('runId' in anchor))
    assert.equal(host.counters.approvals, 0)
    assert.deepEqual(assertReplayPaths(host).usage, LEGACY_USAGE, 'Historical aggregate is not derivable from absent run evidence')
  })
}

for (const scenario of CORPUS) {
  test(`paired CLI/Desktop ${scenario} settles exact returned state and has identical full/incremental/reload projections`, async () => {
    const projections = []
    for (const host of pair()) {
      await host.initialize()
      const metadata = hostMetadata(host.kind, host.storage.read().document)
      const { result, record, events, liveCursors, releaseLate } = await host.runCase(scenario)
      const contract = expected[scenario]
      assert.equal(result.status, contract.status)
      assert.equal(result.rounds, contract.rounds)
      assert.deepEqual(result.usage, contract.usage)
      assert.equal(result.error?.code, contract.error)
      assert.deepEqual(record.snapshot.history.map(entry => entry.message), result.history)
      const { history: _history, ...settlement } = result
      assert.deepEqual(record.settlement, settlement)
      assert.equal(record.inputHistoryLength, LEGACY_HISTORY.length + 1)
      assert.equal(record.sequence, 2)
      assert.equal(record.previousEventId, 'event-1')
      assert.equal(host.storage.read().journal.length, 2)
      assert.deepEqual(host.storage.read().journal.map(item => item.type), ['session_snapshot', 'run_settled'])
      assert.ok(liveCursors.every(cursor => cursor.sequence === 1 && cursor.journalRecords === 1), 'Live callbacks cannot admit a partial durable history')
      assert.deepEqual(record.snapshot.history.slice(0, LEGACY_HISTORY.length), LEGACY_HISTORY)
      assert.deepEqual(hostMetadata(host.kind, host.storage.read().document), metadata)
      for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) assert.equal(host.committed.usage[key], LEGACY_USAGE[key] + result.usage[key])
      assert.equal(host.counters.servers, contract.servers)
      assert.equal(host.counters.approvals, contract.approvals)
      if (contract.outcome) {
        const evidence = record.snapshot.outcomes.find(item => item.callId === `${scenario}-call`)
        assert.deepEqual([evidence.status, evidence.effect], contract.outcome)
        assert.equal(evidence.runId, `${scenario}-run`)
        const acceptedCall = result.history.flatMap(message => message.kind === 'assistant' ? message.toolCalls : []).find(call => call.id === evidence.callId)
        assert.equal(evidence.name, acceptedCall.name)
        assert.equal(evidence.argumentsDigest, agentArgumentsDigest(acceptedCall.arguments))
        assert.deepEqual(host.acknowledgements, [{ eventId: 'event-2', sequence: 2, evidenceDigest: agentEvidenceDigest(evidence), evidence }])
        const commitIndex = host.storage.trace.lastIndexOf(`${host.kind === 'CLI' ? 'session-file-rename' : 'session-transaction'}:committed`)
        assert.ok(host.storage.trace.findIndex(line => line.startsWith('ack:event-2:')) > commitIndex)
      } else assert.deepEqual(record.snapshot.outcomes, [], 'Missing exact evidence stays absent, even when a generic closure says run_failed')
      if (scenario === 'hook_failure') {
        assert.deepEqual(events, ['assistant'])
        assert.equal(JSON.parse(result.history.at(-1).content).error.code, 'run_failed')
        assert.deepEqual(record.settlement.usage, ROUND_USAGE, 'Accepted usage survives a failing display hook')
      }
      if (scenario === 'cancel_no_send' || scenario === 'cancel_unknown') {
        assert.equal(JSON.parse(result.history.at(-1).content).error.code, 'cancelled')
        assert.ok(!events.includes('tool_completed'), 'No final tool callback is required for complete settled history')
      }
      if (scenario === 'partial_stream' || scenario === 'late_provider') {
        assert.ok(host.liveProgress.join('').startsWith('display-only'))
        assert.ok(!JSON.stringify(host.storage.read()).includes('display-only'), 'Partial provider progress stays transient')
      }
      const durableBeforeLate = host.storage.read(), projectionBeforeLate = host.committed
      const publicationsBeforeLate = host.published.length, acksBeforeLate = clone(host.acknowledgements)
      await releaseLate()
      assert.deepEqual(host.storage.read(), durableBeforeLate)
      assert.equal(host.committed, projectionBeforeLate)
      assert.equal(host.published.length, publicationsBeforeLate)
      assert.deepEqual(host.acknowledgements, acksBeforeLate)
      assert.ok(!host.liveProgress.join('').includes('obsolete callback progress'))
      if (scenario === 'cancel_unknown') assert.equal(host.counters.lateResultsIgnored, 1)
      if (scenario === 'late_callback') assert.equal(host.counters.lateCallbacksIgnored, 1)
      projections.push(assertReplayPaths(host))
    }
    assert.deepEqual(projections[0], projections[1])
  })
}

test('both adapters run the same complete corpus in one ordered settled-only history', async () => {
  const projections = []
  for (const host of pair()) {
    await host.initialize()
    for (const scenario of CORPUS) {
      const before = host.committed.sequence
      const { liveCursors, releaseLate } = await host.runCase(scenario)
      assert.ok(liveCursors.every(cursor => cursor.sequence === before && cursor.journalRecords === before))
      await releaseLate()
      assertReplayPaths(host)
    }
    const journal = host.storage.read().journal
    assert.deepEqual(journal.map(record => record.sequence), Array.from({ length: CORPUS.length + 1 }, (_item, index) => index + 1))
    assert.deepEqual(journal.slice(1).map(record => record.runId), CORPUS.map(scenario => `${scenario}-run`))
    assert.equal(host.committed.runs.length, CORPUS.length)
    assert.ok(host.committed.usage.totalTokens > host.committed.runs.reduce((sum, run) => sum + run.usage.totalTokens, 0))
    projections.push(host.committed)
  }
  assert.deepEqual(projections[0], projections[1])
})

for (const kind of HOST_KINDS) {
  test(`${kind} a later exact ledger receipt cannot invent a different original run when terminal evidence was absent`, async () => {
    const host = new OfflineHostAdapter(kind)
    await host.initialize()
    const { result } = await host.runCase('hook_failure')
    assert.deepEqual(host.committed.outcomes, [])
    const call = result.history.flatMap(message => message.kind === 'assistant' ? message.toolCalls : []).find(item => item.id === 'hook_failure-call')
    assert.deepEqual(host.committed.callBindings, [{ callId: call.id, runId: 'hook_failure-run', name: call.name,
      argumentsDigest: agentArgumentsDigest(call.arguments) }])
    const forgedEvidence = host.recordEvidence(call, 'forged-original-run', 'denied', 'not_attempted')
    const forged = decodeAgentRecord({ ...host.envelope({ reference: 'fixture://later-ledger', revision: 'receipt-1' }),
      type: 'session_snapshot', reason: 'reconciliation', snapshot: {
        history: clone(host.committed.history), outcomes: [forgedEvidence], usage: clone(host.committed.usage)
      } })
    const before = host.committed, durable = host.storage.read()
    await assert.rejects(host.commit(forged), /original run\/call binding mismatch/)
    assert.equal(host.committed, before)
    assert.deepEqual(host.storage.read(), durable)
    assert.deepEqual(host.acknowledgements, [])
  })

  test(`${kind} a later raw terminal record cannot overwrite the already settled run`, async () => {
    const host = new OfflineHostAdapter(kind)
    await host.initialize()
    const { record } = await host.runCase('success')
    const duplicateRun = decodeAgentRecord({ ...clone(record), ...host.envelope({ reference: 'fixture://late-terminal', revision: 'late-2' }),
      inputHistoryLength: host.committed.history.length,
      settlement: { status: 'completed', content: '', rounds: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } })
    const before = host.committed, durable = host.storage.read()
    await assert.rejects(host.commit(duplicateRun), /already has a terminal settlement/)
    assert.equal(host.committed, before)
    assert.deepEqual(host.storage.read(), durable)
  })

  test(`${kind} omitted committed cache counts make the host aggregate unreported, while a zero-round run preserves it`, async () => {
    const host = new OfflineHostAdapter(kind)
    await host.initialize()
    const empty = await host.runCase('partial_stream')
    assert.equal(empty.result.rounds, 0)
    assert.equal(host.committed.usage.cachedInputTokens, LEGACY_USAGE.cachedInputTokens)
    const omitted = await host.runCase('success', { omitFirstRoundCache: true })
    assert.equal(omitted.result.rounds, 2)
    assert.ok(!Object.hasOwn(omitted.result.usage, 'cachedInputTokens'))
    assert.ok(!Object.hasOwn(host.committed.usage, 'cachedInputTokens'))
    const reportingAgain = await host.runCase('denied')
    assert.equal(reportingAgain.result.usage.cachedInputTokens, combinedUsage.cachedInputTokens)
    assert.ok(!Object.hasOwn(host.committed.usage, 'cachedInputTokens'), 'A later known count cannot fill an earlier unreported aggregate')
    assert.notEqual(reportingAgain.result.usage.totalTokens, reportingAgain.result.usage.inputTokens + reportingAgain.result.usage.outputTokens,
      'Provider totalTokens is authoritative and need not equal input plus output')
    assertReplayPaths(host)
  })

  test(`${kind} failed checkpoint keeps the old cursor and exact stronger sidecar; retry checkpoints byte-identical evidence before acknowledgement`, async () => {
    const host = new OfflineHostAdapter(kind)
    await host.initialize()
    const { releaseLate } = await host.runCase('cancel_unknown')
    await releaseLate()
    const previous = host.committed, durable = host.storage.read(), acks = clone(host.acknowledgements)
    const refined = host.receiveExactRefinement('cancel_unknown-call')
    const stronger = clone(host.sidecar.get('cancel_unknown-call'))
    assert.equal(stronger.effect, 'confirmed')
    assert.equal(stronger.supersedes, agentEvidenceDigest(previous.outcomes[0]))
    host.storage.failNext = true
    await assert.rejects(host.commit(refined), /Owned checkpoint failed/)
    assert.equal(host.committed, previous)
    assert.deepEqual(host.storage.read(), durable)
    assert.deepEqual(host.sidecar.get('cancel_unknown-call'), stronger)
    assert.deepEqual(host.acknowledgements, acks, 'Stronger evidence cannot be acknowledged against the old unknown checkpoint')
    assert.equal(host.published.at(-1), previous)
    const pending = host.pending, attempted = host.storage.attempts.at(-1)
    const dispatchBeforeRetry = clone(host.counters)
    assert.deepEqual(pending.record, refined)
    await assert.rejects(host.commit(refined), /exact pending checkpoint/)
    await host.retryCheckpoint()
    assert.deepEqual(host.counters, dispatchBeforeRetry, 'Exact retry never repeats provider generation, approval, or server dispatch')
    assert.equal(host.storage.attempts.at(-1), attempted, 'Retry does not regenerate IDs, timestamps, source revisions, history, or bytes')
    assert.equal(host.committed.sequence, 3)
    assert.equal(host.committed.runs.length, 1, 'Reconciliation is not a second run settlement')
    assert.deepEqual(host.committed.outcomes[0], stronger)
    assert.equal(host.acknowledgements.length, acks.length + 1)
    assert.equal(host.acknowledgements.at(-1).eventId, 'event-3')
    assert.equal(host.acknowledgements.at(-1).evidenceDigest, agentEvidenceDigest(stronger))
    const seam = kind === 'CLI' ? 'session-file-rename' : 'session-transaction'
    assert.ok(host.storage.trace.lastIndexOf('ack:event-3:cancel_unknown-call') > host.storage.trace.lastIndexOf(`${seam}:committed`))
    assertReplayPaths(host)
  })

  test(`${kind} first settlement checkpoint failure retains accepted usage and unacknowledged exact evidence until retry`, async () => {
    const host = new OfflineHostAdapter(kind)
    await host.initialize()
    const prepared = await host.runCase('success', { checkpoint: false })
    const previous = host.committed, before = host.storage.read()
    assert.equal(host.sidecar.get('success-call').effect, 'confirmed')
    assert.deepEqual(host.acknowledgements, [])
    host.storage.failNext = true
    await assert.rejects(host.commit(prepared.record), /Owned checkpoint failed/)
    assert.equal(host.committed, previous)
    assert.deepEqual(host.storage.read(), before)
    assert.deepEqual(host.acknowledgements, [])
    assert.deepEqual(host.pending.record.settlement.usage, combinedUsage)
    const dispatchBeforeRetry = clone(host.counters)
    await host.retryCheckpoint()
    assert.deepEqual(host.counters, dispatchBeforeRetry)
    assert.deepEqual(host.committed.runs[0].usage, combinedUsage)
    assert.equal(host.acknowledgements[0].sequence, 2)
    assertReplayPaths(host)
  })
}

const poisoners = {
  'envelope source': record => { record.source.reference = `fixture://${POISON}` },
  'message source': record => { record.snapshot.history[LEGACY_HISTORY.length + 1].source.reference = `fixture://${POISON}` },
  'providerState opaque nested item': record => { record.snapshot.history[LEGACY_HISTORY.length + 1].message.providerState.items.push({ nested: { token: POISON } }) },
  'settlement-only error message': record => {
    record.settlement.status = 'error'
    record.settlement.error = { code: 'event_error', message: POISON }
  },
  'outcome source': record => { record.snapshot.outcomes[0].source.reference = `fixture://${POISON}` }
}
for (const kind of HOST_KINDS) {
  for (const [location, poison] of Object.entries(poisoners)) {
    test(`${kind} screens ${location} in the complete envelope before checkpoint or restored publication`, async () => {
      const host = new OfflineHostAdapter(kind)
      await host.initialize()
      const prepared = await host.runCase('success', { checkpoint: false })
      const malicious = clone(prepared.record)
      poison(malicious)
      // Structurally valid input cannot bypass host privacy policy, even when the
      // poison is invisible in rendered message content or projection run rows.
      decodeAgentRecord(malicious)
      const durable = host.storage.read(), before = host.committed, publications = host.published.length
      await assert.rejects(host.commit(malicious), /privacy screen/)
      assert.equal(host.pending, null)
      assert.equal(host.committed, before)
      assert.deepEqual(host.storage.read(), durable)
      assert.equal(host.published.length, publications)
      assert.deepEqual(host.acknowledgements, [])
      await host.commit(prepared.record)
      const stored = host.storage.read()
      poison(stored.journal.at(-1))
      host.storage.durable = stored // Owned corruption injection, never a production store.
      const restoring = new OfflineHostAdapter(kind, host.storage)
      assert.throws(() => restoring.restore(), /privacy screen/)
      assert.equal(restoring.committed.sequence, 0)
      assert.deepEqual(restoring.published, [])
      assert.equal(restoring.counters.tools + restoring.counters.servers + restoring.counters.approvals, 0)
    })
  }

  test(`${kind} screens preserved host metadata before commit and publication`, async () => {
    const document = legacyDocument(kind)
    if (kind === 'CLI') document.notes = POISON
    else document.session.notes = POISON
    const host = new OfflineHostAdapter(kind)
    host.storage.durable.document = document
    await assert.rejects(host.initialize(), /privacy screen/)
    assert.equal(host.committed.sequence, 0)
    assert.equal(host.storage.read().journal.length, 0)
    assert.deepEqual(host.published, [])
  })

  test(`${kind} an old duplicate after explicit privacy redaction returns the latest screened snapshot`, async () => {
    const host = new OfflineHostAdapter(kind)
    await host.initialize()
    const original = host.storage.read().journal[0]
    const history = clone(host.committed.history)
    history[0].message.content = '[redacted]'
    history[0].source.revision = 'privacy-2'
    const privacy = decodeAgentRecord({ ...host.envelope({ reference: 'fixture://privacy', revision: 'privacy-2' }),
      type: 'session_snapshot', reason: 'privacy', snapshot: { history, outcomes: [], usage: clone(host.committed.usage) } })
    await host.commit(privacy)
    const latest = host.committed, publications = host.published.length
    assert.equal(applyAgentRecord(latest, original), latest)
    assert.equal(await host.commit(original), latest)
    assert.equal(host.published.length, publications)
    assert.equal(host.storage.read().journal.length, 2)
    assert.equal(latest.history[0].message.content, '[redacted]')
    assert.ok(!JSON.stringify(latest).includes('existing request'), 'Old duplicate bridges retain hashes, not superseded bodies')
    assertReplayPaths(host)
  })

  test(`${kind} subscription-before-list race rejects the delayed older snapshot using the committed sequence cursor`, async () => {
    const host = new OfflineHostAdapter(kind)
    await host.initialize()
    const view = new CursorView(host), delayedList = gate(), oldSnapshot = host.committed
    const listResponse = delayedList.promise.then(() => view.receive(oldSnapshot))
    await host.runCase('success')
    const latest = host.committed
    assert.equal(view.value, latest)
    delayedList.resolve()
    assert.equal(await listResponse, false)
    assert.equal(view.rejectedOlder, 1)
    assert.equal(view.value, latest)
    assert.equal(view.value.sequence, 2)
    assert.deepEqual(view.value.history, latest.history)
    view.unsubscribe()
  })

  test(`${kind} no mid-log bootstrap or second legacy import can publish partial reconstructed state`, async () => {
    const host = new OfflineHostAdapter(kind)
    await host.initialize()
    await host.runCase('success')
    const journal = host.storage.read().journal
    assert.throws(() => projectAgentRecords(SESSION_ID, journal.slice(1)), /gap|predecessor/)
    const lateImport = { ...clone(journal[0]), eventId: 'event-3', sequence: 3, previousEventId: 'event-2', snapshot: clone(journal[1].snapshot) }
    await assert.rejects(host.commit(lateImport), /Legacy import must be the initial anchor/)
    const stored = host.storage.read()
    stored.journal = stored.journal.slice(1)
    host.storage.durable = stored
    const restoring = new OfflineHostAdapter(kind, host.storage)
    assert.throws(() => restoring.restore(), /gap|predecessor/)
    assert.equal(restoring.committed.sequence, 0)
    assert.deepEqual(restoring.published, [])
  })
}

test('host fixture scope names bounded journal follow-up separately from the 1 MiB record contract', () => {
  assert.equal(AGENT_RECORD_LIMITS.bytes, 1024 * 1024)
  assert.equal(AGENT_RECORD_LIMITS.records, 2048)
  assert.equal(AGENT_RECORD_LIMITS.journalBytes, 64 * 1024 * 1024)
  // A full settled snapshot repeats history, so 1 MiB records, 2048 records, and
  // the independent 64 MiB journal ceiling are separate limits. Production host
  // retention/compaction/rotation is a separate follow-up, not implemented or
  // claimed by these memory adapters. A mid-log bootstrap is not a workaround.
})
