// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { runAgent } from '../../dist/index.js'
import {
  agentArgumentsDigest, agentEvidenceDigest, applyAgentRecord, createAgentProjection,
  createRunSettlement, decodeAgentRecord, projectAgentRecords
} from '../../dist/events.js'
import {
  applyAgentRunRecord, assertAgentRunCurrent, createAgentAcceptedRecord, createAgentRunProjection,
  createAgentRunStart, createAgentRunTerminal, decodeAgentRunRecord, projectAgentRunRecords
} from '../../dist/events/stream.js'
import {
  FINAL_USAGE, HOST_KINDS, LEGACY_HISTORY, LEGACY_USAGE, POISON, ROUND_USAGE,
  SESSION_ID, gate, hostMetadata, legacyDocument, privacyScreen, tick
} from './agent-record-hosts.mjs'

// Owned, offline paired adapters. They model an atomic in-memory durability
// oracle, not fsync/SQLite, native adoption, live MCP delivery, or host approval.
// The existing anchor fixture remains the source of legacy identities/metadata.
export { FINAL_USAGE, HOST_KINDS, LEGACY_HISTORY, LEGACY_USAGE, POISON, ROUND_USAGE, SESSION_ID, gate, hostMetadata, tick }
export const STREAM_CORPUS = [
  'success', 'denied', 'failed_confirmed', 'cancel_no_send', 'cancel_unknown',
  'partial_stream', 'hook_failure', 'assistant_hook_failure', 'result_hook_failure',
  'late_callback', 'late_provider'
]
const clone = value => structuredClone(value)
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const source = (runId, revision = 'accepted-1') => ({ reference: `fixture://stream/${runId}`, revision })
const seam = kind => kind === 'CLI' ? 'session-file-rename' : 'session-transaction'

function replaceDocument(kind, document, projection) {
  const output = clone(document)
  if (kind === 'CLI') { output.messages = clone(projection.history); output.usage = clone(projection.usage) }
  else { output.transcript = clone(projection.history); output.totalUsage = clone(projection.usage) }
  return output
}
function sessionUsage(previous, admitted, rounds) {
  const output = clone(previous)
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) output[key] += admitted[key]
  if (rounds) for (const key of ['cachedInputTokens', 'cacheWriteInputTokens']) {
    if (previous[key] !== undefined && admitted[key] !== undefined) output[key] += admitted[key]
    else delete output[key]
  }
  return output
}

export class StreamMemoryStorage {
  constructor(kind) {
    this.kind = kind
    this.durable = { document: legacyDocument(kind), journal: [], runs: {} }
    this.attempts = []
    this.trace = []
    this.failNext = null
    this.failRead = false
    this.beforeCheckpoint = null
    this.afterCheckpoint = null
  }
  read() {
    if (this.failRead) { this.failRead = false; throw new Error('Owned ambiguous checkpoint readback failed') }
    return clone(this.durable)
  }
  async checkpoint(candidate, expected) {
    // Atomic CAS is part of this owned memory oracle. A real file/DB adapter
    // needs an equivalent transaction/lock; a mere pre-write read is inadequate.
    const beforeCheckpoint = this.beforeCheckpoint
    this.beforeCheckpoint = null
    if (beforeCheckpoint) await beforeCheckpoint()
    if (!same(this.durable, expected)) throw new Error('Owned checkpoint CAS conflict')
    const mode = this.failNext
    this.failNext = null
    this.attempts.push(JSON.stringify(candidate))
    this.trace.push(`${seam(this.kind)}:attempt`)
    if (mode === 'before') { this.trace.push(`${seam(this.kind)}:failed-before`); throw new Error('Owned checkpoint failed before durable write') }
    this.durable = clone(candidate)
    this.trace.push(`${seam(this.kind)}:committed`)
    const afterCheckpoint = this.afterCheckpoint
    this.afterCheckpoint = null
    if (afterCheckpoint) await afterCheckpoint()
    if (mode === 'after' || mode === 'after_unreadable') {
      if (mode === 'after_unreadable') this.failRead = true
      throw new Error('Owned checkpoint failed after durable write')
    }
  }
}

export class OfflineStreamHostAdapter {
  constructor(kind, storage) {
    assert.ok(HOST_KINDS.includes(kind))
    this.kind = kind
    this.storage = storage ?? new StreamMemoryStorage(kind)
    this.committed = createAgentProjection(SESSION_ID)
    this.active = null
    this.pending = null
    this.sidecar = new Map()
    this.acknowledgements = []
    this.published = []
    this.listeners = new Set()
    this.quarantined = []
    this.admittedWrites = []
    this.accepted = []
    this.liveProgress = []
    this.policyRevision = 'policy-current'
    this.validatedRevision = null
    this.counters = { providers: 0, tools: 0, servers: 0, approvals: 0, policyChecks: 0, lateResultsIgnored: 0, lateCallbacksIgnored: 0 }
  }
  sessionEnvelope(reference = 'fixture://session') {
    return { version: 1, sessionId: SESSION_ID, eventId: `event-${this.committed.sequence + 1}`,
      sequence: this.committed.sequence + 1, previousEventId: this.committed.eventId,
      source: { reference, revision: 'checkpoint-1' } }
  }
  runEnvelope(runId = this.active.runId) {
    const cursor = this.active
    return { version: 1, scope: 'run', sessionId: SESSION_ID, runId,
      eventId: `${runId}-event-${cursor.sequence + 1}`, sequence: cursor.sequence + 1,
      previousEventId: cursor.eventId, source: source(runId) }
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  view() {
    return { session: this.committed, run: this.active,
      incomplete: this.active !== null && this.active.state !== 'settled', approvalRestored: false }
  }
  publish() {
    const stored = this.storage.read()
    this.ensureCurrent(stored)
    const value = this.view()
    privacyScreen({ ...value, document: stored.document })
    this.published.push(value)
    for (const listener of this.listeners) listener(value)
  }
  async initialize() {
    const stored = this.storage.read()
    if (stored.journal.length) return this.restore()
    const metadata = hostMetadata(this.kind, stored.document)
    await this.commitSession(decodeAgentRecord({ ...this.sessionEnvelope(metadata.source.reference), source: metadata.source,
      type: 'session_snapshot', reason: 'legacy_import',
      snapshot: { history: LEGACY_HISTORY, outcomes: [], usage: LEGACY_USAGE } }))
    return this.committed
  }
  restore(runId) {
    const stored = this.storage.read()
    const session = projectAgentRecords(SESSION_ID, stored.journal)
    privacyScreen({ journal: stored.journal, document: stored.document, session })
    let active = null
    const retained = runId === undefined ? null : stored.runs[runId]
    if (retained) {
      const start = retained.records[0]
      const terminal = retained.records.at(-1)
      const completedAtCurrentCursor = terminal?.type === 'run_settled' &&
        session.receipts.some(receipt => receipt.eventId === terminal.terminal.eventId && receipt.sequence === terminal.terminal.sequence)
      if (!completedAtCurrentCursor && (start.baseSequence !== session.sequence || start.baseEventId !== session.eventId ||
          start.baseReceiptDigest !== (session.receipts.at(-1)?.digest ?? null))) {
        // A validated newer privacy/reconciliation cursor wins before any old
        // active payload is replayed or published. Retain only quarantine IDs.
        this.quarantined.push({ runId, reason: 'superseded-session-watermark' })
      } else {
        const base = projectAgentRecords(SESSION_ID, retained.baseJournal)
        active = projectAgentRunRecords(base, runId, retained.records)
        // A later session rewrite also invalidates a settled historical view.
        if (active.state === 'settled' && active.session.sequence !== session.sequence)
          this.quarantined.push({ runId, reason: 'superseded-session-watermark' })
        else {
          if (active.state === 'settled') assert.deepEqual(active.session, session, 'Run terminal must match the independently validated session checkpoint')
          privacyScreen({ records: retained.records, active, document: stored.document })
        }
        if (active.state === 'settled' && active.session.sequence !== session.sequence) active = null
      }
    }
    this.committed = session
    this.active = active
    this.validatedRevision = null // Reload never restores an approval/policy gate.
    this.publish()
    return this.view()
  }
  async commitSession(input) {
    if (this.pending) throw new Error('Retry the exact pending checkpoint first')
    const record = decodeAgentRecord(input)
    privacyScreen(record)
    const stored = this.storage.read()
    this.ensureCurrent(stored)
    const session = applyAgentRecord(this.committed, record)
    if (session === this.committed) { privacyScreen(this.view()); return session }
    const candidate = { ...stored, document: replaceDocument(this.kind, stored.document, session), journal: [...stored.journal, record] }
    privacyScreen({ record, candidate, session })
    this.pending = { record, candidate, expected: stored, session, run: null }
    await this.retryCheckpoint()
    return this.committed
  }
  async start(runId, input) {
    assert.equal(this.active?.state === 'running', false, 'Do not automatically resume an incomplete run')
    this.active = createAgentRunProjection(this.committed, runId)
    const record = createAgentRunStart(this.runEnvelope(runId), this.committed, input)
    await this.appendRunRecord(record)
    return record
  }
  prepareAccepted(update) {
    return createAgentAcceptedRecord({ envelope: this.runEnvelope(), update,
      historyId: `${this.active.runId}-message-${this.active.history.length}`,
      source: { reference: `fixture://messages/${this.active.runId}/${this.active.history.length}`, revision: 'accepted-1' } })
  }
  async appendRunRecord(input) {
    if (this.pending) throw new Error('Retry the exact pending checkpoint first')
    const record = decodeAgentRunRecord(input)
    privacyScreen(record)
    const stored = this.storage.read()
    this.ensureCurrent(stored)
    const run = applyAgentRunRecord(this.active, record)
    if (run === this.active) { privacyScreen(this.view()); return run }
    const retained = stored.runs[run.runId] ?? { baseJournal: clone(stored.journal), records: [] }
    const session = record.type === 'run_settled' ? run.session : this.committed
    const candidate = { ...stored,
      document: record.type === 'run_settled' ? replaceDocument(this.kind, stored.document, session) : stored.document,
      journal: record.type === 'run_settled' ? [...stored.journal, record.terminal] : stored.journal,
      runs: { ...stored.runs, [run.runId]: { baseJournal: retained.baseJournal, records: [...retained.records, record] } } }
    privacyScreen({ record, candidate, run, session })
    this.pending = { record, candidate, expected: stored, session, run }
    await this.retryCheckpoint()
    return this.active
  }
  async retryCheckpoint() {
    assert.ok(this.pending, 'There must be an exact pending checkpoint')
    const pending = this.pending
    let verified = false
    try { verified = same(this.storage.read(), pending.candidate) } catch { /* Uncertain old read does not commit. */ }
    if (!verified) {
      try { await this.storage.checkpoint(pending.candidate, pending.expected) }
      catch (error) {
        try { verified = same(this.storage.read(), pending.candidate) } catch { /* Leave the old committed cursor. */ }
        if (!verified && /CAS conflict/.test(error.message)) {
          this.ensureCurrent(this.storage.read())
          throw error
        }
        if (!verified) throw error
      }
      if (!verified) verified = same(this.storage.read(), pending.candidate)
    }
    if (!verified) this.ensureCurrent(this.storage.read())
    assert.ok(verified, 'Exact durable checkpoint readback is required')
    this.committed = pending.session
    if (pending.run) this.active = pending.run
    else if (this.active && this.active.session.sequence !== this.committed.sequence) {
      this.quarantined.push({ runId: this.active.runId, reason: 'superseded-session-watermark' })
      this.active = null
    }
    this.pending = null
    if (pending.record.scope === 'run' && pending.record.type === 'run_settled') this.acknowledge(pending.record.terminal)
    else if (pending.record.scope !== 'run') this.acknowledge(pending.record)
    this.publish()
    return this.view()
  }
  ensureCurrent(stored) {
    const current = projectAgentRecords(SESSION_ID, stored.journal)
    privacyScreen({ journal: stored.journal, document: stored.document, session: current })
    let conflict = !same(current, this.committed)
    if (!conflict && this.active) {
      if (this.active.state !== 'settled') {
        try { assertAgentRunCurrent(this.active, current) } catch { conflict = true }
      }
      const retained = stored.runs[this.active.runId]
      if (retained) {
        try {
          const base = this.active.state === 'settled' ? projectAgentRecords(SESSION_ID, retained.baseJournal) : current
          const replayed = projectAgentRunRecords(base, this.active.runId, retained.records)
          privacyScreen({ records: retained.records, run: replayed, document: stored.document })
          // IDs/cursors alone cannot detect different bytes at the same cursor,
          // nor a rewritten earlier record whose final receipt is unchanged.
          // Full validated projection comparison includes every receipt digest.
          if (!same(replayed, this.active) || (replayed.state === 'settled' && !same(replayed.session, current))) conflict = true
        } catch { conflict = true }
      } else if (this.active.sequence !== 0) conflict = true
    }
    if (!conflict) return
    if (this.active) this.quarantined.push({ runId: this.active.runId, reason: 'superseded-storage-watermark' })
    this.active = null; this.pending = null; this.committed = current; this.validatedRevision = null
    // Never emit an old view merely because a local callback admitted it.
    const safe = this.view()
    privacyScreen({ ...safe, document: stored.document })
    this.published.push(safe)
    for (const listener of this.listeners) listener(safe)
    throw new Error('Owned current session/run storage anchor is obsolete; stale view quarantined')
  }
  acknowledge(record) {
    assert.ok(same(this.storage.read().journal[record.sequence - 1], record), 'Only verified terminal/session bytes acknowledge exact evidence')
    for (const evidence of record.snapshot.outcomes) {
      const retained = this.sidecar.get(evidence.callId), digest = agentEvidenceDigest(evidence)
      if (!retained || agentEvidenceDigest(retained) !== digest || this.acknowledgements.some(item => item.evidenceDigest === digest)) continue
      this.storage.trace.push(`ack:${record.eventId}:${evidence.callId}`)
      this.acknowledgements.push({ eventId: record.eventId, sequence: record.sequence, evidenceDigest: digest, evidence: clone(evidence) })
    }
  }
  recordEvidence(call, runId, status, effect, previous) {
    const evidence = { callId: call.id, runId, name: call.name, argumentsDigest: agentArgumentsDigest(call.arguments), status, effect,
      source: { reference: `fixture://mcp-outcomes/${call.id}`, revision: previous ? 'receipt-2' : 'receipt-1' },
      // A pre-terminal sidecar refinement has no durable prior receipt. Only a
      // previously committed receipt can create a public supersedes bridge.
      ...(previous && this.committed.outcomes.some(item => same(item, previous)) ? { supersedes: agentEvidenceDigest(previous) } : {}) }
    this.sidecar.set(call.id, clone(evidence))
    return evidence
  }
  async revalidatePolicy(expectedRevision) {
    this.counters.policyChecks++
    assert.equal(expectedRevision, this.policyRevision, 'Current policy/source revisions must be revalidated before any new turn')
    this.validatedRevision = expectedRevision
  }
  async runCase(scenario, { checkpoint = true, omitFirstRoundCache = false, omitFinalRoundCache = false,
    writeGate, returnedGate, refineAfterCancel = false, runId = `${scenario}-run` } = {}) {
    assert.ok(STREAM_CORPUS.includes(scenario) || scenario === 'cancel_admitted_write' || scenario === 'cancel_admitted_result')
    await this.revalidatePolicy(this.policyRevision)
    const base = this.committed, originalLength = base.history.length
    const input = [{ id: `${runId}-message-${originalLength}`, source: { reference: `fixture://messages/${runId}/${originalLength}`, revision: 'accepted-1' },
      message: { kind: 'message', role: 'user', content: `owned request: ${scenario}` } }]
    await this.start(runId, input)
    const controller = new AbortController(), late = gate(), owner = { state: 'running' }
    const call = { id: `${scenario}-call`, name: 'offline_fixture', arguments: { label: scenario } }
    const events = [], hookCursors = [], admitted = [], start = this.active
    let round = 0, savedProgress
    const firstUsage = clone(ROUND_USAGE), finalUsage = clone(FINAL_USAGE)
    if (omitFirstRoundCache) delete firstUsage.cachedInputTokens
    if (omitFinalRoundCache) delete finalUsage.cachedInputTokens
    const first = { content: 'accepted fixture', toolCalls: [call], usage: firstUsage,
      providerState: { provider: 'offline', items: [{ opaque: 'owned fixture state' }] } }
    const provider = { generate: async (_input, _signal, options) => {
      this.counters.providers++; round++; savedProgress = options.onProgress
      if (scenario === 'partial_stream') {
        await options.onProgress({ type: 'text_delta', text: 'display-only partial stream' })
        throw new Error('Owned provider failed before acceptance')
      }
      if (scenario === 'late_provider') {
        await options.onProgress({ type: 'text_delta', text: 'display-only obsolete provider' })
        queueMicrotask(() => controller.abort())
        return late.promise
      }
      if (scenario === 'late_callback') return { ...first, toolCalls: [] }
      return round === 1 ? first : { content: 'owned final answer', toolCalls: [], usage: finalUsage }
    } }
    const rawResult = await runAgent({ provider,
      messages: start.history.map(entry => clone(entry.message)), signal: controller.signal,
      tools: [{ name: call.name, description: 'Inert owned fixture', parameters: {} }],
      executeTool: async acceptedCall => {
        assert.equal(this.validatedRevision, this.policyRevision)
        assert.equal(owner.state, 'running')
        assert.equal(this.active.history.at(-1).message.kind, 'assistant', 'Accepted assistant is durably checkpointed before dispatch')
        this.counters.tools++; this.counters.approvals++
        if (scenario === 'denied') {
          this.recordEvidence(acceptedCall, runId, 'denied', 'not_attempted')
          return { content: 'Owned exact approval denial', isError: true }
        }
        this.counters.servers++
        if (scenario === 'cancel_unknown') {
          this.recordEvidence(acceptedCall, runId, 'cancelled', 'unknown')
          queueMicrotask(() => controller.abort())
          await late.promise
          if (owner.state !== 'running') { this.counters.lateResultsIgnored++; return { content: 'ignored late result' } }
        }
        if (refineAfterCancel) {
          this.recordEvidence(acceptedCall, runId, 'cancelled', 'unknown')
          return { content: 'Owned unconfirmed generic result', isError: true }
        }
        this.recordEvidence(acceptedCall, runId, scenario === 'failed_confirmed' ? 'failed' : 'succeeded', 'confirmed')
        return { content: scenario === 'failed_confirmed' ? 'Owned confirmed failure' : 'Owned confirmed success',
          ...(scenario === 'failed_confirmed' ? { isError: true } : {}) }
      },
      onAccepted: async update => {
        this.accepted.push(update)
        const record = this.prepareAccepted(update)
        const delay = writeGate && ((scenario === 'cancel_admitted_write' && update.type === 'assistant_accepted') ||
          (scenario === 'cancel_admitted_result' && update.type === 'tool_result_accepted'))
        const write = (async () => {
          if (delay) {
            queueMicrotask(() => controller.abort())
            await writeGate.promise
            if (refineAfterCancel) this.recordEvidence(call, runId, 'succeeded', 'confirmed', this.sidecar.get(call.id))
          }
          // Once admitted, this exact write must finish even when the core has
          // returned cancellation. Closing a progress gate cannot erase it.
          await this.appendRunRecord(record)
        })()
        admitted.push(write); this.admittedWrites.push(write)
        await write
        if (scenario === 'assistant_hook_failure' && update.type === 'assistant_accepted') throw new Error('Owned accepted assistant hook failed')
        if (scenario === 'result_hook_failure' && update.type === 'tool_result_accepted') throw new Error('Owned accepted result hook failed')
      },
      onEvent: async event => {
        if (owner.state !== 'running') return
        events.push(event.type)
        hookCursors.push({ type: event.type, runSequence: this.active.sequence, sessionSequence: this.committed.sequence })
        if (event.type === 'text_delta') this.liveProgress.push(event.text)
        if (scenario === 'hook_failure' && event.type === 'assistant') throw new Error('Owned display hook failed')
        if (scenario === 'cancel_no_send' && event.type === 'tool_started') {
          // An independently owned closed dispatch gate supplies no-send proof.
          this.recordEvidence(event.call, runId, 'cancelled', 'not_attempted'); controller.abort()
        }
        if (scenario === 'late_callback' && event.type === 'assistant') {
          queueMicrotask(() => controller.abort()); await late.promise
          if (owner.state !== 'running') { this.counters.lateCallbacksIgnored++; return }
          this.liveProgress.push('obsolete callback must never publish')
        }
      }
    })
    owner.state = 'settled'
    returnedGate?.resolve(rawResult)
    await Promise.allSettled(admitted)
    if (this.pending) await this.retryCheckpoint()
    this.storage.trace.push(`drained:${runId}`)
    let history = rawResult.history.map((message, index) => index < this.active.history.length
      ? { ...clone(this.active.history[index]), message: clone(message) }
      : { id: `${runId}-message-${index}`, source: { reference: `fixture://messages/${runId}/${index}`, revision: 'accepted-1' }, message: clone(message) })
    if (refineAfterCancel) history = history.map(entry => entry.message.kind === 'tool_result' && entry.message.callId === call.id
      ? { ...entry, source: { ...entry.source, revision: 'reconciled-2' }, message: { ...entry.message, content: 'Owned independently confirmed server success', isError: false } }
      : entry)
    const result = { ...clone(rawResult), history: history.map(entry => clone(entry.message)) }
    const outcomes = [...base.outcomes.filter(item => !this.sidecar.has(item.callId)), ...this.sidecar.values()]
    const terminal = createRunSettlement({ envelope: this.sessionEnvelope(`fixture://runs/${runId}`), runId,
      inputHistoryLength: start.inputHistoryLength, result, history, outcomes,
      sessionUsage: sessionUsage(base.usage, result.usage, result.rounds) })
    const record = createAgentRunTerminal(this.runEnvelope(), terminal)
    if (checkpoint) await this.appendRunRecord(record)
    return { result, rawResult, record, terminal, events, hookCursors, start,
      releaseLate: async () => {
        late.resolve({ content: 'obsolete provider response', toolCalls: [], usage: ROUND_USAGE })
        await savedProgress?.({ type: 'text_delta', text: 'obsolete callback progress' }); await tick()
      } }
  }
}

/** Subscribe before asynchronous list/read; both order domains are watermarks. */
export class StreamCursorView {
  constructor(host) {
    this.value = { session: createAgentProjection(SESSION_ID), run: null, incomplete: false, approvalRestored: false }
    this.rejectedSession = 0; this.rejectedRun = 0
    this.unsubscribe = host.subscribe(value => this.receive(value))
  }
  receive(value) {
    const before = this.value
    if (value.session.sequence < before.session.sequence) { this.rejectedSession++; return false }
    if (value.session.sequence === before.session.sequence && value.session.eventId !== before.session.eventId) throw new Error('Conflicting session cursor')
    if (value.run && before.run && value.run.runId === before.run.runId && value.run.sequence < before.run.sequence) {
      this.rejectedRun++; return false
    }
    if (value.run && value.run.state !== 'settled' && value.run.baseSequence < value.session.sequence) { this.rejectedSession++; return false }
    if (value.run && before.run && value.run.runId === before.run.runId && value.run.sequence === before.run.sequence && value.run.eventId !== before.run.eventId)
      throw new Error('Conflicting run cursor')
    this.value = value
    return true
  }
}
