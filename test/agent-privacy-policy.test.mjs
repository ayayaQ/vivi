// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  agentEvidenceDigest, applyAgentRecord, decodeAgentRecord, projectAgentRecords
} from '../dist/events.js'
import { projectAgentRunRecords } from '../dist/events/stream.js'
import { HOST_KINDS, OfflineHostAdapter, SESSION_ID } from './fixtures/agent-record-hosts.mjs'
import { OfflineStreamHostAdapter } from './fixtures/agent-stream-hosts.mjs'

// Test-only CURRENT host policy around the existing owned memory adapters. The
// markers below are synthetic data, never real credentials. This is not a new
// core API, production host adoption, credential detector, or native/fsync proof.
const clone = value => structuredClone(value)
const OPAQUE = 'owned fixture state'
const modes = { session: OfflineHostAdapter, stream: OfflineStreamHostAdapter }
const executionCounters = host => ['providers', 'tools', 'servers', 'approvals'].map(key => host.counters[key])

function currentPolicyGate(host, policy = { denied: [], revision: 1 }) {
  const gate = { host, policy, displayed: null, quarantine: [] }, listeners = new Set()
  const emit = value => { gate.displayed = value; for (const listener of listeners) listener(value) }
  const withdraw = error => {
    // Withdrawal is not an empty-history replacement or a successfully loaded
    // cursor. Keep the exact cached/pending bytes and sidecar quarantined.
    host.validatedRevision = null
    if (gate.displayed !== null) emit(null)
    gate.quarantine.push({ sessionId: SESSION_ID, reason: error.message })
  }
  const prefix = (records, label) => assert.ok(Array.isArray(records) && records[0]?.sequence === 1 &&
    records[0]?.previousEventId === null, `${label} requires the complete sequence-1 prefix; no bootstrap fallback`)
  const check = candidate => {
    try {
      const stored = host.storage.read()
      // These are restoration paths for an already persisted chain. Core's
      // legitimate empty *new* projection must not disguise deleted old data.
      prefix(stored.journal, 'Persisted session')
      for (const retained of Object.values(stored.runs ?? {})) {
        prefix(retained.baseJournal, 'Retained run session base')
        prefix(retained.records, 'Persisted run')
        assert.equal(retained.records[0].type, 'run_started', 'Restore cannot guess a run anchor')
      }
      // Fixtures supply plain, core-decoded JSON. Screen every retained body,
      // document, current projection and candidate, including hidden provenance.
      const bytes = JSON.stringify({ stored, session: host.committed, run: host.active, candidate })
      if (policy.denied.some(marker => bytes.includes(marker))) throw new Error('Current host privacy policy rejects retained envelope')
      return stored
    } catch (error) { withdraw(error); throw error }
  }
  const publish = host.publish.bind(host), retry = host.retryCheckpoint.bind(host)
  host.publish = (...args) => {
    check(args)
    publish(...args)
    emit(host.view ? host.view() : { session: args[0], run: null, incomplete: false, approvalRestored: false })
  }
  // Recheck the exact candidate immediately before a retry can enter storage.
  // A prior admission under policy revision 1 is not permission under revision 2.
  host.retryCheckpoint = async () => { check(host.pending); return retry() }
  gate.subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  gate.publish = () => host.view ? host.publish() : host.publish(host.committed, host.storage.read().document)
  gate.commit = async record => { check(decodeAgentRecord(record)); return host.commitSession ? host.commitSession(record) : host.commit(record) }
  gate.retry = () => host.retryCheckpoint()
  gate.reload = runId => {
    check()
    try { return host.restore(runId) } catch (error) { withdraw(error); throw error }
  }
  gate.changePolicy = marker => {
    policy.denied.push(marker); policy.revision++
    assert.throws(() => check(), /Current host privacy policy/)
  }
  return gate
}

function refinement(host) {
  const before = host.committed.outcomes[0]
  assert.equal(before.effect, 'unknown')
  const stronger = { ...clone(before), status: 'succeeded', effect: 'confirmed',
    source: { ...clone(before.source), revision: 'independent-exact-2' }, supersedes: agentEvidenceDigest(before) }
  host.sidecar.set(before.callId, clone(stronger))
  const history = host.committed.history.map(entry => entry.message.kind === 'tool_result' && entry.message.callId === before.callId
    ? { ...clone(entry), source: { ...clone(entry.source), revision: 'reconciled-2' },
      message: { ...clone(entry.message), content: 'Owned independently confirmed success', isError: false } } : clone(entry))
  const envelope = host.sessionEnvelope ? host.sessionEnvelope('fixture://policy-reconciliation')
    : host.envelope({ reference: 'fixture://policy-reconciliation', revision: 'reconciled-2' })
  return { stronger, record: decodeAgentRecord({ ...envelope, type: 'session_snapshot', reason: 'reconciliation',
    snapshot: { history, outcomes: [stronger], usage: clone(host.committed.usage) } }) }
}

function privacyRecord(host) {
  const history = host.committed.history.map(entry => {
    const output = clone(entry)
    if (output.message.providerState !== undefined) {
      delete output.message.providerState
      output.source.revision = 'privacy-2'
    }
    return output
  })
  const envelope = host.sessionEnvelope ? host.sessionEnvelope('fixture://privacy')
    : host.envelope({ reference: 'fixture://privacy', revision: 'privacy-2' })
  return decodeAgentRecord({ ...envelope, type: 'session_snapshot', reason: 'privacy',
    snapshot: { history, outcomes: clone(host.committed.outcomes), usage: clone(host.committed.usage) } })
}

for (const kind of HOST_KINDS) for (const [mode, Adapter] of Object.entries(modes)) {
  for (const location of ['nested opaque state', 'immutable outcome source']) {
    test(`${kind} ${mode} changed CURRENT policy withdraws ${location} and blocks exact candidate re-persistence`, async () => {
      const host = new Adapter(kind); await host.initialize()
      const prepared = await host.runCase('cancel_unknown'); await prepared.releaseLate()
      const gate = currentPolicyGate(host), displayed = []
      gate.subscribe(value => displayed.push(value)); gate.publish()
      const previous = host.committed, durable = host.storage.read(), { stronger, record } = refinement(host)
      const marker = location === 'nested opaque state' ? OPAQUE : stronger.source.reference
      assert.ok(JSON.stringify(durable).includes(marker), 'These exact bytes were allowed and actually persisted before the policy changed')
      const acks = clone(host.acknowledgements), counters = clone(host.counters)
      host.storage.failNext = mode === 'stream' ? 'before' : true
      await assert.rejects(gate.commit(record), /checkpoint failed/)
      assert.equal(host.committed, previous); assert.deepEqual(host.storage.read(), durable)
      const pending = host.pending, candidateBytes = JSON.stringify(pending.candidate)
      const attempts = host.storage.attempts.length, publications = host.published.length
      gate.changePolicy(marker)
      assert.equal(gate.policy.revision, 2); assert.equal(gate.displayed, null); assert.equal(displayed.at(-1), null)
      assert.equal(host.validatedRevision, null, 'A changed policy invalidates any previously checked policy/approval gate')
      await assert.rejects(gate.retry(), /Current host privacy policy/)
      assert.throws(() => gate.publish(), /Current host privacy policy/)
      assert.throws(() => gate.reload('cancel_unknown-run'), /Current host privacy policy/)
      // A structurally valid privacy candidate is not a sanitized bootstrap:
      // replay bodies, run records and immutable evidence are screened too.
      const sanitized = privacyRecord(host)
      applyAgentRecord(previous, sanitized)
      if (location === 'nested opaque state') assert.equal(JSON.stringify(sanitized).includes(marker), false)
      await assert.rejects(gate.commit(sanitized), /Current host privacy policy/)
      assert.equal(host.storage.attempts.length, attempts); assert.equal(host.published.length, publications)
      assert.deepEqual(host.storage.read(), durable); assert.equal(host.committed, previous)
      assert.equal(host.pending, pending); assert.equal(JSON.stringify(host.pending.candidate), candidateBytes)
      assert.deepEqual(host.sidecar.get(stronger.callId), stronger)
      assert.equal(host.sidecar.get(stronger.callId).supersedes, agentEvidenceDigest(previous.outcomes[0]))
      assert.deepEqual(host.acknowledgements, acks, 'Confirmed sidecar evidence is neither weakened nor acknowledged against the older unknown checkpoint')
      assert.deepEqual(host.counters, counters, 'Blocking a persistence retry never repeats provider/tool/server/approval work')
      const restoring = new Adapter(kind, host.storage), reload = currentPolicyGate(restoring, gate.policy)
      assert.throws(() => reload.reload('cancel_unknown-run'), /Current host privacy policy/)
      assert.equal(restoring.committed.sequence, 0); assert.equal(restoring.active ?? null, null)
      assert.equal(reload.displayed, null); assert.deepEqual(restoring.published, [])
      assert.deepEqual(executionCounters(restoring), [0, 0, 0, 0]); assert.equal(restoring.validatedRevision, null)
      assert.deepEqual(restoring.acknowledgements, []); assert.ok(gate.quarantine.length > 0)
    })
  }

  test(`${kind} ${mode} old screened replay bodies cannot be recovered by deleting prefixes or guessing a sanitized anchor`, async () => {
    const host = new Adapter(kind); await host.initialize(); await host.runCase('success')
    const gate = currentPolicyGate(host)
    await gate.commit(privacyRecord(host))
    const complete = host.storage.read(), current = projectAgentRecords(SESSION_ID, complete.journal)
    assert.equal(JSON.stringify(current).includes(OPAQUE), false)
    assert.ok(JSON.stringify(complete).includes(OPAQUE), 'A privacy snapshot does not physically erase prior stored bodies')
    const allowed = new Adapter(kind, host.storage), allowedGate = currentPolicyGate(allowed)
    allowedGate.reload('success-run')
    assert.deepEqual(allowed.committed, current); assert.equal(allowedGate.displayed.approvalRestored, false)
    assert.deepEqual(executionCounters(allowed), [0, 0, 0, 0]); assert.equal(allowed.validatedRevision ?? null, null)
    gate.publish(); gate.changePolicy(OPAQUE)
    assert.equal(gate.displayed, null, 'Even a sanitized latest projection is withheld if required old replay bodies violate CURRENT policy')
    assert.throws(() => gate.reload('success-run'), /Current host privacy policy/)
    const deletions = {
      'session sequence 1': stored => { stored.journal = stored.journal.slice(1) },
      'entire session prefix': stored => { stored.journal = [] },
      'all but sanitized sequence-N snapshot': stored => { stored.journal = stored.journal.slice(-1) }
    }
    if (mode === 'stream') Object.assign(deletions, {
      'run sequence 1': stored => { stored.runs['success-run'].records = stored.runs['success-run'].records.slice(1) },
      'entire run prefix': stored => { stored.runs['success-run'].records = [] },
      'run session-base prefix': stored => { stored.runs['success-run'].baseJournal = [] }
    })
    assert.throws(() => projectAgentRecords(SESSION_ID, complete.journal.slice(1)), /gap|predecessor/)
    if (mode === 'stream') {
      const retained = complete.runs['success-run'], base = projectAgentRecords(SESSION_ID, retained.baseJournal)
      assert.throws(() => projectAgentRunRecords(base, 'success-run', retained.records.slice(1)), /gap|predecessor|start/i)
    }
    for (const [label, erase] of Object.entries(deletions)) {
      // Owned memory-only erasure simulation. Bounded v1 cannot resume this same
      // chain afterward. Quarantine is supported; sanitized bootstrap is not.
      const erased = clone(complete); erase(erased); host.storage.durable = erased
      const restoring = new Adapter(kind, host.storage), reload = currentPolicyGate(restoring, gate.policy)
      const attempts = host.storage.attempts.length
      assert.throws(() => reload.reload('success-run'), /complete sequence-1 prefix/, label)
      assert.equal(reload.displayed, null); assert.equal(restoring.committed.sequence, 0)
      assert.equal(restoring.active ?? null, null); assert.deepEqual(restoring.published, [])
      assert.deepEqual(executionCounters(restoring), [0, 0, 0, 0]); assert.equal(restoring.validatedRevision, null)
      assert.deepEqual(restoring.acknowledgements, []); assert.equal(host.storage.attempts.length, attempts)
      assert.deepEqual(host.storage.read(), erased, 'No legacy re-import, empty-history save, guessed anchor or replacement chain is persisted')
      assert.equal(reload.quarantine.length, 1)
    }
  })
}
