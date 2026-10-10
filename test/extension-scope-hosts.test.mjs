// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createExtensionScope } from '../dist/extensions.js'
import { runAgent } from '../dist/index.js'

// Offline ownership adapters, not production-host adoption or permission authority.
// CLI contracts: https://github.com/ayayaQ/vivi-cli/blob/2f94b29f4a3a58ba93cde250d64f60258e086407/src/host.ts#L590-L645
// Candidate publication: https://github.com/ayayaQ/vivi-cli/blob/2f94b29f4a3a58ba93cde250d64f60258e086407/src/application.ts#L470-L524
// Desktop run/persistence: https://github.com/ayayaQ/bot-commander-desktop/blob/c8b63325b5fbd50b5da2f35ec3c3485815b4dcfb/src/main/services/agentService.ts#L866-L901
// Listener seam: https://github.com/ayayaQ/bot-commander-desktop/blob/c8b63325b5fbd50b5da2f35ec3c3485815b4dcfb/src/main/services/agentMcpService.ts#L236-L248
// Every service, lease, listener, provider and persistence sink below is owned and inert.

const gate = () => {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const context = () => ({ signal: new AbortController().signal })
const call = (name = 'fixture') => ({ id: 'offline-call', name, arguments: {} })
const extension = (name = 'fixture', execute = () => ({ content: name })) => ({
  id: `${name}-extension`, apiVersion: 1, tools: [{
    definition: { name, description: 'Owned offline host fixture', parameters: { type: 'object' } },
    validateArguments() {}, execute
  }]
})
const isOpen = owner => owner.state === 'open' && !owner.signal.aborted
const failure = code => ({ content: JSON.stringify({ success: false, error: { code } }), isError: true })
function track(jobs, failures, work) {
  jobs.add(work)
  void work.then(() => jobs.delete(work), error => { failures.push(error); jobs.delete(work) })
  return work
}
async function drain(jobs, failures) {
  while (jobs.size) await Promise.allSettled([...jobs])
  // Completion of admitted durability is separate from successful durability.
  if (failures.length) throw new AggregateError([...failures], 'Owned host event work failed')
}

for (const phase of ['initialization', 'previous-host shutdown']) {
  test(`CLI ${phase} failure rolls back only the candidate, retaining its published predecessor`, async t => {
    const releases = [], predecessor = createExtensionScope()
    predecessor.register(extension('established'))
    predecessor.defer(() => { releases.push('established lease') })
    const established = { scope: predecessor, registry: predecessor.snapshot() }
    const published = established
    let candidate, candidateRegistry, previousShutdowns = 0
    t.after(async () => { await candidate?.dispose(); await predecessor.dispose() })

    // The corrected host boundary includes initialization AND predecessor shutdown
    // in candidate rollback. Nothing publishes before both gates have succeeded.
    const openCandidate = async () => {
      candidate = createExtensionScope()
      candidate.defer(() => { releases.push('candidate lease') })
      candidate.defer(() => { releases.push('candidate listener') })
      try {
        candidate.register(extension('candidate'))
        candidateRegistry = candidate.snapshot()
        if (phase === 'initialization') throw new Error('Synthetic initialization failure')
        previousShutdowns++
        throw new Error('Synthetic previous-host shutdown failure')
      } catch (error) {
        await candidate.dispose()
        throw error
      }
    }

    await assert.rejects(openCandidate(), /Synthetic/)
    assert.equal(published, established)
    assert.equal(previousShutdowns, phase === 'initialization' ? 0 : 1)
    assert.deepEqual(releases, ['candidate listener', 'candidate lease'])
    assert.equal(candidate.state, 'closed')
    assert.equal(predecessor.state, 'open')
    assert.equal(predecessor.signal.aborted, false)
    assert.equal((await published.registry.executeTool(call('established'), context())).content, 'established')
    await assert.rejects(candidateRegistry.executeTool(call('candidate'), context()), { name: 'AbortError' })
    await predecessor.dispose()
    assert.deepEqual(releases, ['candidate listener', 'candidate lease', 'established lease'])
  })
}

test('CLI failed predecessor disposal rolls back its candidate without reopening ownership or losing the retryable resource', async t => {
  const predecessor = createExtensionScope(), candidate = createExtensionScope()
  const retainedResource = { id: 'old-lease', releaseAttempts: 0 }, released = []
  const cleanupFailure = new Error('Synthetic retained lease cleanup failure')
  predecessor.register(extension('established'))
  predecessor.defer(() => { retainedResource.releaseAttempts++; throw cleanupFailure })
  candidate.register(extension('candidate'))
  candidate.defer(() => { released.push('candidate lease') })
  candidate.defer(() => { released.push('candidate listener') })
  const published = { scope: predecessor, resource: retainedResource, registry: predecessor.snapshot() }
  const candidateRegistry = candidate.snapshot()
  t.after(async () => { await Promise.allSettled([predecessor.dispose(), candidate.dispose()]) })

  // Publication waits for old teardown. A failed teardown retains its exact host
  // resource owner, while the candidate is rolled back and cannot be published.
  const predecessorDisposal = predecessor.dispose()
  await assert.rejects((async () => {
    try { await predecessorDisposal }
    catch (error) { await candidate.dispose(); throw error }
  })(), error => error instanceof AggregateError && error.errors[0] === cleanupFailure)
  assert.equal(published.scope, predecessor)
  assert.equal(published.resource, retainedResource)
  assert.equal(retainedResource.releaseAttempts, 1)
  assert.deepEqual(released, ['candidate listener', 'candidate lease'])
  assert.equal(predecessor.state, 'closed')
  assert.equal(candidate.state, 'closed')
  assert.equal(predecessor.dispose(), predecessorDisposal)
  await assert.rejects(published.registry.executeTool(call('established'), context()), { name: 'AbortError' })
  await assert.rejects(candidateRegistry.executeTool(call('candidate'), context()), { name: 'AbortError' })
  // Scope retry never repeats cleanup or silently drops the host-retained lease.
  await assert.rejects(predecessor.dispose(), AggregateError)
  assert.equal(retainedResource.releaseAttempts, 1)
})

test('CLI a late lease is immediately released by its exact failed owner, never adopted by its replacement', async t => {
  const opening = gate(), old = createExtensionScope(), next = createExtensionScope()
  const released = [], lateLease = { id: 'late-old-lease' }, nextLease = { id: 'next-lease' }
  let current = old
  const release = lease => { released.push(lease) }
  const acquireForOld = (async () => {
    const acquired = await opening.promise
    // defer requires open; the host, rather than the scope, owns late acquisition.
    if (current !== old || !isOpen(old)) { await release(acquired); return false }
    old.defer(() => release(acquired))
    return true
  })()
  t.after(async () => { opening.resolve(lateLease); await acquireForOld; await old.dispose(); await next.dispose() })
  await old.dispose()
  current = next
  next.defer(() => release(nextLease))
  next.register(extension('next'))
  const nextRegistry = next.snapshot()
  opening.resolve(lateLease)
  assert.equal(await acquireForOld, false)
  assert.deepEqual(released, [lateLease])
  assert.throws(() => old.defer(() => release(nextLease)))
  assert.equal(next.signal.aborted, false)
  assert.equal((await nextRegistry.executeTool(call('next'), context())).content, 'next')
  await next.dispose()
  assert.deepEqual(released, [lateLease, nextLease])
})

test('CLI late-acquisition cleanup failure belongs to the acquisition caller, outside completed scope disposal', async t => {
  const owner = createExtensionScope(), next = createExtensionScope(), opening = gate()
  const lease = { id: 'late-retained-lease' }, cleanupFailure = new Error('Synthetic late lease release failure')
  const releaseAttempts = []
  const acquisition = (async () => {
    const acquired = await opening.promise
    if (!isOpen(owner)) {
      releaseAttempts.push(acquired)
      throw cleanupFailure // Caller retains this exact lease for its host-owned retry.
    }
    owner.defer(() => { releaseAttempts.push(acquired) })
  })()
  t.after(async () => {
    opening.resolve(lease)
    await Promise.allSettled([acquisition, owner.dispose(), next.dispose()])
  })
  const disposal = owner.dispose()
  await disposal
  assert.deepEqual(releaseAttempts, [])
  assert.equal(owner.state, 'closed')
  next.register(extension('replacement'))
  const replacement = next.snapshot()
  const failedAcquisition = assert.rejects(acquisition, error => error === cleanupFailure)
  opening.resolve(lease)
  await failedAcquisition
  assert.deepEqual(releaseAttempts, [lease])
  assert.equal(owner.dispose(), disposal)
  await disposal // Success covers only cleanup transferred while the owner was open.
  assert.equal(next.state, 'open')
  assert.equal((await replacement.executeTool(call('replacement'), context())).content, 'replacement')
})

for (const boundary of ['checkpoint', 'display callback']) {
  test(`CLI shutdown drains non-MCP event work at the ${boundary} await and rejects obsolete continuations`, async t => {
    const owner = createExtensionScope(), blocked = gate(), entered = gate(), jobs = new Set(), failures = []
    const durable = [], displayed = [], cleanup = []
    let current = owner, disposalFinished = false, callbacksEntered = 0
    const isCurrent = () => current === owner && isOpen(owner)
    owner.defer(() => { cleanup.push('lease released') })
    owner.defer(() => drain(jobs, failures))
    owner.register(extension())
    const registry = owner.snapshot()
    const onEvent = event => {
      if (!isCurrent()) return Promise.resolve()
      callbacksEntered++
      return track(jobs, failures, (async () => {
        // Canonical persistence admitted while current must settle even after abort.
        if (boundary === 'checkpoint') { entered.resolve(); await blocked.promise }
        durable.push(structuredClone(event.message))
        if (!isCurrent()) return
        if (boundary === 'display callback') {
          entered.resolve()
          await blocked.promise
          // A wrapper cannot stop trusted callback code already entered.
          if (!isCurrent()) return
        }
        displayed.push(structuredClone(event.message))
      })())
    }
    t.after(async () => { blocked.resolve(); await drain(jobs, failures); await owner.dispose() })
    const running = runAgent({
      provider: { async generate() { return { content: 'accepted offline assistant', toolCalls: [] } } },
      messages: [], tools: registry.tools, executeTool: registry.executeTool,
      signal: owner.signal, onEvent
    })
    await entered.promise
    const disposing = owner.dispose()
    void disposing.then(() => { disposalFinished = true })
    assert.equal(owner.state, 'closing')
    assert.equal(owner.signal.aborted, true)
    const result = await running
    const settledResult = structuredClone(result)
    assert.equal(result.status, 'cancelled')
    assert.equal(disposalFinished, false)
    assert.equal(jobs.size, 1)
    assert.deepEqual(cleanup, [])
    await onEvent({ type: 'assistant', message: { kind: 'assistant', content: 'late', toolCalls: [] } })
    assert.equal(callbacksEntered, 1)
    await assert.rejects(registry.executeTool(call(), context()), { name: 'AbortError' })
    blocked.resolve()
    await disposing
    current = undefined
    assert.equal(jobs.size, 0)
    assert.equal(durable.length, 1)
    assert.equal(durable[0].content, 'accepted offline assistant')
    assert.deepEqual(displayed, [])
    assert.deepEqual(cleanup, ['lease released'])
    assert.deepEqual(result, settledResult)
  })
}

test('CLI rejected admitted persistence remains observable through failed disposal while all cleanup is attempted', async t => {
  const owner = createExtensionScope(), neighbor = createExtensionScope(), pendingWrite = gate()
  const jobs = new Set(), failures = [], displayed = [], cleanup = []
  const writeFailure = new Error('Synthetic admitted checkpoint rejection')
  let writeAttempts = 0
  owner.defer(() => { cleanup.push('lease released') })
  owner.defer(() => drain(jobs, failures))
  neighbor.register(extension('neighbor'))
  const neighborRegistry = neighbor.snapshot()
  const onEvent = () => {
    if (!isOpen(owner)) return Promise.resolve()
    return track(jobs, failures, (async () => {
      writeAttempts++
      await pendingWrite.promise
      if (!isOpen(owner)) return
      displayed.push('saved')
    })())
  }
  t.after(async () => {
    pendingWrite.resolve()
    await Promise.allSettled([owner.dispose(), neighbor.dispose()])
  })
  const work = onEvent()
  const rejectedWork = assert.rejects(work, error => error === writeFailure)
  const disposing = owner.dispose()
  const rejectedDisposal = assert.rejects(disposing, error => error instanceof AggregateError &&
    error.errors[0] instanceof AggregateError && error.errors[0].errors[0] === writeFailure)
  assert.equal(owner.state, 'closing')
  assert.equal(jobs.size, 1)
  await onEvent()
  assert.equal(writeAttempts, 1)
  pendingWrite.reject(writeFailure)
  await Promise.all([rejectedWork, rejectedDisposal])
  assert.equal(owner.state, 'closed')
  assert.deepEqual(failures, [writeFailure])
  assert.equal(jobs.size, 0)
  assert.deepEqual(displayed, [])
  assert.deepEqual(cleanup, ['lease released'])
  assert.equal(owner.dispose(), disposing)
  await assert.rejects(owner.dispose(), AggregateError)
  assert.equal((await neighborRegistry.executeTool(call('neighbor'), context())).content, 'neighbor')
})

test('CLI open ownership never bypasses human denial, hard deny, or changed approval revisions', async t => {
  const owner = createExtensionScope({ reservedNames: ['note_set', 'save_skill', 'list_mcp_resources'] })
  const policy = { mode: 'Auto', revision: 'catalog-1', hardDeny: false, approve: async () => false }
  const sent = [], proposals = []
  t.after(() => owner.dispose())
  owner.register(extension('mcp_owned_fixture', async (received, { signal }) => {
    const reviewedRevision = policy.revision
    if (policy.hardDeny) return failure('hard_deny')
    // CLI's MCP review is explicitly ineligible for automated approval.
    proposals.push({ call: received, currentRevision: reviewedRevision, eligible: false })
    const approved = await policy.approve()
    signal.throwIfAborted()
    owner.signal.throwIfAborted()
    if (policy.hardDeny) return failure('hard_deny')
    if (policy.revision !== reviewedRevision) return failure('revision_conflict')
    if (!approved) return failure('approval_denied')
    sent.push(received)
    return { content: JSON.stringify({ success: true }) }
  }))
  const registry = owner.snapshot(), invoke = () => registry.executeTool(call('mcp_owned_fixture'), context())
  for (const reserved of ['note_set', 'save_skill', 'list_mcp_resources']) {
    assert.throws(() => owner.register(extension(reserved)), /Tool name collision/)
  }
  const errorCode = result => { assert.equal(result.isError, true); return JSON.parse(result.content).error.code }
  assert.equal(errorCode(await invoke()), 'approval_denied')
  assert.equal(sent.length, 0)
  const approved = gate(), reviewEntered = gate()
  policy.approve = () => { reviewEntered.resolve(); return approved.promise }
  const stale = invoke()
  await reviewEntered.promise
  policy.revision = 'catalog-2'
  approved.resolve(true)
  assert.equal(errorCode(await stale), 'revision_conflict')
  policy.approve = async () => { policy.hardDeny = true; return true }
  assert.equal(errorCode(await invoke()), 'hard_deny')
  assert.equal(sent.length, 0)
  policy.hardDeny = false
  policy.approve = async () => true
  assert.equal(JSON.parse((await invoke()).content).success, true)
  assert.equal(sent.length, 1)
  assert.equal(policy.mode, 'Auto')
  assert.equal(proposals.every(proposal => proposal.eligible === false), true)
  assert.deepEqual(registry.tools.map(tool => tool.name), ['mcp_owned_fixture'])
})

test('Desktop run disposal unsubscribes and drains admitted persistence without closing app-owned MCP or another run', async t => {
  const app = createExtensionScope(), controllers = new Map(), deletedSessionIds = new Set()
  const service = {
    connected: true, disconnects: 0, listeners: new Set(),
    onStatusChanged(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) },
    notify(status) { for (const listener of this.listeners) listener(status) }
  }
  app.defer(() => { service.connected = false; service.disconnects++ })
  const beforeAdmission = gate(), persistence = gate(), waitingBefore = gate(), waitingPersist = gate()
  const runs = []
  const createRun = (sessionId, runId) => {
    const scope = createExtensionScope(), jobs = new Set(), failures = [], admitted = [], committed = [], displayed = []
    const session = { id: sessionId, activeRunId: runId }
    controllers.set(sessionId, scope.signal)
    // Match Desktop's exact session/run/controller/deletion admission checks.
    const isCurrent = () => isOpen(scope) && session.activeRunId === runId &&
      controllers.get(sessionId) === scope.signal && !deletedSessionIds.has(sessionId)
    scope.defer(() => { if (controllers.get(sessionId) === scope.signal) controllers.delete(sessionId) })
    scope.defer(() => drain(jobs, failures))
    const callback = status => {
      if (!isCurrent()) return
      track(jobs, failures, (async () => {
        if (status.beforeAdmission) { waitingBefore.resolve(); await status.beforeAdmission }
        if (!isCurrent()) return
        admitted.push(status.id)
        if (status.persistence) { waitingPersist.resolve(); await status.persistence }
        committed.push(status.id) // Already-admitted durable work is never abandoned.
        if (!isCurrent()) return
        displayed.push(status.id)
      })())
    }
    const unsubscribe = service.onStatusChanged(callback)
    scope.defer(unsubscribe) // Reverse teardown removes ingress before draining jobs.
    scope.register(extension('fixture_status', () => ({ content: service.connected ? 'connected' : 'disconnected' })))
    const run = { scope, registry: scope.snapshot(), jobs, failures, admitted, committed, displayed, callback }
    runs.push(run)
    return run
  }
  const first = createRun('session-1', 'run-1'), second = createRun('session-2', 'run-2')
  t.after(async () => {
    beforeAdmission.resolve(); persistence.resolve()
    for (const run of runs) await run.scope.dispose()
    await app.dispose()
  })
  // Captured callbacks also model notification delivery already queued before unsubscribe.
  first.callback({ id: 'not-admitted', beforeAdmission: beforeAdmission.promise })
  first.callback({ id: 'admitted', persistence: persistence.promise })
  await Promise.all([waitingBefore.promise, waitingPersist.promise])
  let disposalFinished = false
  const disposing = first.scope.dispose()
  void disposing.then(() => { disposalFinished = true })
  assert.equal(first.scope.signal.aborted, true)
  first.callback({ id: 'late-entry' })
  await Promise.resolve()
  assert.equal(service.listeners.has(first.callback), false)
  assert.equal(service.listeners.has(second.callback), true)
  assert.equal(disposalFinished, false)
  assert.equal(service.connected, true)
  service.notify({ id: 'neighbor-live' })
  await drain(second.jobs, second.failures)
  assert.deepEqual(second.committed, ['neighbor-live'])
  assert.deepEqual(second.displayed, ['neighbor-live'])
  assert.equal((await second.registry.executeTool(call('fixture_status'), context())).content, 'connected')
  beforeAdmission.resolve(); persistence.resolve()
  await disposing
  assert.deepEqual(first.admitted, ['admitted'])
  assert.deepEqual(first.committed, ['admitted'])
  assert.deepEqual(first.displayed, [])
  assert.equal(first.jobs.size, 0)
  assert.equal(controllers.has('session-1'), false)
  assert.equal(controllers.get('session-2'), second.scope.signal)
  assert.equal(second.scope.state, 'open')
  assert.equal(service.disconnects, 0)
  await assert.rejects(first.registry.executeTool(call('fixture_status'), context()), { name: 'AbortError' })
  await second.scope.dispose()
  assert.equal(service.listeners.size, 0)
  assert.equal(service.connected, true)
  assert.equal(service.disconnects, 0)
  await app.dispose()
  assert.equal(service.connected, false)
  assert.equal(service.disconnects, 1)
})
