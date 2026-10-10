// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { runAgent } from '../../dist/index.js'
import {
  agentArgumentsDigest, agentEvidenceDigest, applyAgentRecord, createAgentProjection,
  createRunSettlement, decodeAgentRecord, projectAgentRecords
} from '../../dist/events.js'

// These small, owned, offline adapters prove a persistence/publication contract.
// They are not imports of vivi-cli or bot-commander-desktop, production adoption,
// completion of CLI-20/Desktop-14, or completion of an eventstream migration.
// No network, native app, credential, real approval service, or MCP SDK is used.
// Their differing file/transaction and legacy-document seams are intentional;
// the durable settlement vocabulary and logical source identities are shared.
export const HOST_KINDS = ['CLI', 'Desktop']
export const SESSION_ID = 'existing-session-id'
export const POISON = 'FORBIDDEN_PRIVATE_MARKER'
export const LEGACY_USAGE = { inputTokens: 200, outputTokens: 40, totalTokens: 240, cachedInputTokens: 100 }
export const ROUND_USAGE = { inputTokens: 8, outputTokens: 2, totalTokens: 12, cachedInputTokens: 3 }
export const FINAL_USAGE = { inputTokens: 5, outputTokens: 1, totalTokens: 6, cachedInputTokens: 2 }
export const CORPUS = [
  'success', 'denied', 'failed_confirmed', 'cancel_no_send', 'cancel_unknown',
  'partial_stream', 'hook_failure', 'late_callback', 'late_provider'
]
export const LEGACY_HISTORY = [
  { id: 'existing-user-message-id', source: { reference: 'legacy://messages/user', revision: 'original' },
    message: { kind: 'message', role: 'user', content: 'existing request' } },
  { id: 'existing-assistant-message-id', source: { reference: 'legacy://messages/assistant', revision: 'original' },
    message: { kind: 'assistant', content: 'existing answer', toolCalls: [
      { id: 'existing-call-id', name: 'offline_fixture', arguments: { label: 'historical' } }
    ], providerState: { provider: 'offline', items: [{ opaque: 'preserved native item' }] } } },
  { id: 'existing-result-message-id', source: { reference: 'legacy://messages/result', revision: 'original' },
    message: { kind: 'tool_result', callId: 'existing-call-id', name: 'offline_fixture', content: 'existing result' } }
]
const LEGACY_METADATA = {
  sessionId: SESSION_ID, source: { reference: 'legacy://existing-session-source', revision: 'original' },
  title: 'Existing session title', notes: 'Keep these existing notes',
  display: { expanded: false, selectedMessageId: 'existing-result-message-id' },
  validation: { state: 'valid', warnings: ['existing host-owned warning'] }
}
const clone = value => structuredClone(value)
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
export const gate = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
export const tick = () => new Promise(resolve => setImmediate(resolve))

export function legacyDocument(kind) {
  if (kind === 'CLI') return {
    id: SESSION_ID, source: clone(LEGACY_METADATA.source), title: LEGACY_METADATA.title,
    notes: LEGACY_METADATA.notes, display: clone(LEGACY_METADATA.display),
    validation: clone(LEGACY_METADATA.validation), messages: clone(LEGACY_HISTORY), usage: clone(LEGACY_USAGE)
  }
  return {
    session: { id: SESSION_ID, source: clone(LEGACY_METADATA.source), title: LEGACY_METADATA.title, notes: LEGACY_METADATA.notes },
    sidebar: clone(LEGACY_METADATA.display), validation: clone(LEGACY_METADATA.validation),
    transcript: clone(LEGACY_HISTORY), totalUsage: clone(LEGACY_USAGE)
  }
}

export function hostMetadata(kind, document) {
  return kind === 'CLI'
    ? { sessionId: document.id, source: document.source, title: document.title, notes: document.notes,
      display: document.display, validation: document.validation }
    : { sessionId: document.session.id, source: document.session.source, title: document.session.title,
      notes: document.session.notes, display: document.sidebar, validation: document.validation }
}
function legacySnapshot(kind, document) {
  return { history: clone(kind === 'CLI' ? document.messages : document.transcript), outcomes: [],
    usage: clone(kind === 'CLI' ? document.usage : document.totalUsage) }
}
function updateDocument(kind, document, projection) {
  const next = clone(document)
  if (kind === 'CLI') { next.messages = clone(projection.history); next.usage = clone(projection.usage) }
  else { next.transcript = clone(projection.history); next.totalUsage = clone(projection.usage) }
  return next
}

// Descriptor-safe core decoding happens before this deliberately simple host
// policy. Screen the complete envelope and host document, never selected text.
export function privacyScreen(value) {
  if (JSON.stringify(value).includes(POISON)) throw new Error('Owned host privacy screen rejected the complete envelope')
}

class MemoryStorage {
  constructor(kind, document = legacyDocument(kind)) {
    this.kind = kind
    this.durable = { document: clone(document), journal: [] }
    this.attempts = []
    this.trace = []
    this.failNext = false
  }
  read() { return clone(this.durable) }
  async replaceAtomically(candidate, seam) {
    this.attempts.push(JSON.stringify(candidate))
    this.trace.push(`${seam}:attempt`)
    if (this.failNext) { this.failNext = false; this.trace.push(`${seam}:failed`); throw new Error('Owned checkpoint failed') }
    // This is an atomic in-memory durability oracle, not proof of fsync/SQLite.
    this.durable = clone(candidate)
    this.trace.push(`${seam}:committed`)
  }
}
export class CliMemoryStorage extends MemoryStorage {
  constructor(document) { super('CLI', document) }
  async checkpoint(candidate) { await this.replaceAtomically(candidate, 'session-file-rename') }
}
export class DesktopMemoryStorage extends MemoryStorage {
  constructor(document) { super('Desktop', document) }
  async checkpoint(candidate) { await this.replaceAtomically(candidate, 'session-transaction') }
}

function sumAuthoritativeUsage(previous, admitted, rounds) {
  // The host's aggregate, including historical usage, is authoritative. The
  // core receives a replacement snapshot; it must not sum replayed run rows.
  const output = clone(previous)
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) output[key] += admitted[key]
  for (const key of ['cachedInputTokens', 'cacheWriteInputTokens']) {
    if (rounds === 0) continue
    if (previous[key] !== undefined && admitted[key] !== undefined) output[key] += admitted[key]
    else delete output[key]
  }
  return output
}

export class OfflineHostAdapter {
  constructor(kind, storage) {
    assert.ok(HOST_KINDS.includes(kind))
    this.kind = kind
    this.storage = storage ?? (kind === 'CLI' ? new CliMemoryStorage() : new DesktopMemoryStorage())
    this.committed = createAgentProjection(SESSION_ID)
    this.pending = null
    this.sidecar = new Map()
    this.acknowledgements = []
    this.published = []
    this.listeners = new Set()
    this.liveProgress = []
    this.counters = { providers: 0, tools: 0, servers: 0, approvals: 0, lateResultsIgnored: 0, lateCallbacksIgnored: 0 }
  }
  envelope(source) {
    return { version: 1, sessionId: SESSION_ID, eventId: `event-${this.committed.sequence + 1}`,
      sequence: this.committed.sequence + 1, previousEventId: this.committed.eventId, source }
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  publish(projection, document) {
    privacyScreen({ projection, document })
    this.published.push(projection)
    for (const listener of this.listeners) listener(projection)
  }
  async initialize() {
    const stored = this.storage.read()
    if (stored.journal.length) return this.restore()
    const metadata = hostMetadata(this.kind, stored.document)
    const initial = decodeAgentRecord({ ...this.envelope(metadata.source), type: 'session_snapshot', reason: 'legacy_import',
      snapshot: legacySnapshot(this.kind, stored.document) })
    await this.commit(initial)
    return this.committed
  }
  restore() {
    const stored = this.storage.read()
    // Full decoding/replay and policy checks finish before assigning or emitting
    // any state. Even poison in an old settlement-only field is screened.
    const projection = projectAgentRecords(SESSION_ID, stored.journal)
    privacyScreen({ journal: stored.journal, document: stored.document, projection })
    this.publish(projection, stored.document)
    this.committed = projection
    return projection
  }
  async commit(input) {
    if (this.pending) throw new Error('Retry the exact pending checkpoint before admitting another record')
    const record = decodeAgentRecord(input)
    const projection = applyAgentRecord(this.committed, record)
    const stored = this.storage.read()
    if (projection === this.committed) {
      // An exact old receipt never republishes its superseded snapshot. No raw
      // duplicate is checkpointed, and the current projection remains screened.
      privacyScreen({ projection, document: stored.document })
      return projection
    }
    const document = updateDocument(this.kind, stored.document, projection)
    privacyScreen({ record, document })
    this.pending = { record, projection, candidate: { document, journal: [...stored.journal, record] } }
    await this.retryCheckpoint()
    return this.committed
  }
  async retryCheckpoint() {
    assert.ok(this.pending, 'There must be an exact pending record to retry')
    const pending = this.pending
    await this.storage.checkpoint(pending.candidate)
    this.committed = pending.projection
    this.pending = null
    this.acknowledgeExactEvidence(pending.record)
    this.publish(this.committed, pending.candidate.document)
    return this.committed
  }
  acknowledgeExactEvidence(record) {
    const checkpointed = this.storage.read().journal[record.sequence - 1]
    assert.ok(same(checkpointed, record), 'Evidence acknowledgement requires the exact durable envelope')
    for (const evidence of record.snapshot.outcomes) {
      const retained = this.sidecar.get(evidence.callId)
      const evidenceDigest = agentEvidenceDigest(evidence)
      if (!retained || evidenceDigest !== agentEvidenceDigest(retained) ||
        this.acknowledgements.some(ack => ack.evidenceDigest === evidenceDigest)) continue
      this.storage.trace.push(`ack:${record.eventId}:${evidence.callId}`)
      this.acknowledgements.push({ eventId: record.eventId, sequence: record.sequence, evidenceDigest, evidence: clone(evidence) })
    }
  }
  recordEvidence(call, runId, status, effect) {
    const evidence = { callId: call.id, runId, name: call.name, argumentsDigest: agentArgumentsDigest(call.arguments),
      status, effect, source: { reference: `fixture://mcp-outcomes/${call.id}`, revision: 'receipt-1' } }
    this.sidecar.set(call.id, decodeAgentRecordEvidence(evidence))
    return evidence
  }
  async runCase(scenario, { checkpoint = true, omitFirstRoundCache = false } = {}) {
    assert.ok(CORPUS.includes(scenario))
    const controller = new AbortController(), late = gate()
    const owner = { state: 'running' }
    const runId = `${scenario}-run`
    const call = { id: `${scenario}-call`, name: 'offline_fixture', arguments: { label: scenario } }
    const messages = [...this.committed.history.map(entry => clone(entry.message)),
      { kind: 'message', role: 'user', content: `owned request: ${scenario}` }]
    const events = [], liveCursors = []
    let savedProgress, round = 0
    const returned = { content: 'accepted fixture', toolCalls: [call], usage: clone(ROUND_USAGE),
      providerState: { provider: 'offline', items: [{ opaque: 'owned fixture state' }] } }
    if (omitFirstRoundCache) delete returned.usage.cachedInputTokens
    const provider = { generate: async (_input, _signal, options) => {
      this.counters.providers++; round++
      savedProgress = options.onProgress
      if (scenario === 'partial_stream') {
        await options.onProgress({ type: 'text_delta', text: 'display-only partial ' })
        await options.onProgress({ type: 'text_delta', text: 'stream' })
        throw new Error('Owned provider failed before an accepted final response')
      }
      if (scenario === 'late_provider') {
        await options.onProgress({ type: 'text_delta', text: 'display-only obsolete provider' })
        queueMicrotask(() => controller.abort())
        return late.promise
      }
      if (scenario === 'late_callback') return { ...returned, toolCalls: [] }
      return round === 1 ? returned : { content: 'owned final answer', toolCalls: [], usage: clone(FINAL_USAGE) }
    } }
    const result = await runAgent({ provider, messages,
      tools: [{ name: 'offline_fixture', description: 'Inert owned fixture', parameters: {} }],
      signal: controller.signal,
      executeTool: async acceptedCall => {
        assert.equal(owner.state, 'running')
        this.counters.tools++; this.counters.approvals++
        if (scenario === 'denied') {
          this.recordEvidence(acceptedCall, runId, 'denied', 'not_attempted')
          return { content: 'Owned exact approval denial', isError: true }
        }
        this.counters.servers++
        if (scenario === 'cancel_unknown') {
          // Dispatch was admitted, but this exact inert server has no outcome
          // receipt at cancellation. A cancellation closure is not no-send proof.
          this.recordEvidence(acceptedCall, runId, 'cancelled', 'unknown')
          queueMicrotask(() => controller.abort())
          await late.promise
          if (owner.state !== 'running') { this.counters.lateResultsIgnored++; return { content: 'late ignored response' } }
        }
        this.recordEvidence(acceptedCall, runId, scenario === 'failed_confirmed' ? 'failed' : 'succeeded', 'confirmed')
        return { content: scenario === 'failed_confirmed' ? 'Owned confirmed server failure' : 'Owned confirmed server success',
          ...(scenario === 'failed_confirmed' ? { isError: true } : {}) }
      },
      onEvent: async event => {
        if (owner.state !== 'running') return
        events.push(event.type)
        liveCursors.push({ sequence: this.committed.sequence, journalRecords: this.storage.read().journal.length })
        if (event.type === 'text_delta') this.liveProgress.push(event.text)
        if (scenario === 'hook_failure' && event.type === 'assistant') throw new Error('Owned display hook failed')
        if (scenario === 'cancel_no_send' && event.type === 'tool_started') {
          // This receipt comes from the host's closed dispatch gate. It is not
          // inferred from tool_started or from the generic cancellation result.
          this.recordEvidence(event.call, runId, 'cancelled', 'not_attempted')
          controller.abort()
        }
        if (scenario === 'late_callback' && event.type === 'assistant') {
          queueMicrotask(() => controller.abort())
          await late.promise
          if (owner.state !== 'running') { this.counters.lateCallbacksIgnored++; return }
          this.liveProgress.push('obsolete callback must never be published')
        }
      }
    })
    owner.state = 'settled'
    const history = result.history.map((message, index) => index < this.committed.history.length
      ? { ...clone(this.committed.history[index]), message: clone(message) }
      : { id: `${runId}-message-${index}`, source: { reference: `fixture://messages/${runId}/${index}`, revision: 'accepted-1' }, message: clone(message) })
    const outcomes = [...this.committed.outcomes.filter(item => !this.sidecar.has(item.callId)), ...this.sidecar.values()]
    const record = createRunSettlement({ envelope: this.envelope({ reference: `fixture://runs/${runId}`, revision: 'terminal-1' }),
      runId, inputHistoryLength: messages.length, result, history, outcomes,
      sessionUsage: sumAuthoritativeUsage(this.committed.usage, result.usage, result.rounds) })
    if (checkpoint) await this.commit(record)
    return { result, record, events, liveCursors, releaseLate: async () => {
      late.resolve({ content: 'obsolete provider result', toolCalls: [], usage: clone(ROUND_USAGE) })
      await savedProgress?.({ type: 'text_delta', text: 'obsolete callback progress' })
      await tick()
    } }
  }
  receiveExactRefinement(callId) {
    const before = this.committed.outcomes.find(item => item.callId === callId)
    assert.ok(before && before.effect === 'unknown')
    // Independent exact evidence is admitted explicitly after terminal settlement;
    // this is not an obsolete executeTool continuation rewriting its own run.
    const after = { ...clone(before), status: 'succeeded', effect: 'confirmed',
      source: { ...clone(before.source), revision: 'receipt-2' }, supersedes: agentEvidenceDigest(before) }
    this.sidecar.set(callId, decodeAgentRecordEvidence(after))
    const history = this.committed.history.map(entry => entry.message.kind === 'tool_result' && entry.message.callId === callId
      ? { ...clone(entry), source: { ...clone(entry.source), revision: 'reconciled-2' },
        message: { ...clone(entry.message), content: 'Owned independently confirmed server success', isError: false } }
      : clone(entry))
    return decodeAgentRecord({ ...this.envelope({ reference: 'fixture://reconciliation', revision: 'receipt-2' }),
      type: 'session_snapshot', reason: 'reconciliation',
      snapshot: { history, outcomes: this.committed.outcomes.map(item => item.callId === callId ? after : clone(item)), usage: clone(this.committed.usage) } })
  }
}

function decodeAgentRecordEvidence(evidence) {
  // Evidence comes from an owned oracle and is cloned/frozen immediately; record
  // decoding/application subsequently checks its exact historical call binding.
  return Object.freeze({ ...clone(evidence), source: Object.freeze(clone(evidence.source)) })
}

export class CursorView {
  constructor(host) {
    this.value = createAgentProjection(SESSION_ID)
    this.rejectedOlder = 0
    // Subscribe before requesting an asynchronous list/file-read snapshot.
    this.unsubscribe = host.subscribe(projection => this.receive(projection))
  }
  receive(projection) {
    if (projection.sequence < this.value.sequence) { this.rejectedOlder++; return false }
    if (projection.sequence === this.value.sequence && projection.eventId !== this.value.eventId) throw new Error('Conflicting snapshot cursor')
    this.value = projection
    return true
  }
}
