// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createCorpus } from './fixtures/hierarchical-context-corpus.mjs'
import { OfflineContext, mockTokenizer, entriesFromRecords, emptyPolicy } from './fixtures/hierarchical-context.mjs'
import { corpusRecord, evaluate } from './fixtures/hierarchical-context-evaluation.mjs'

const fixture = () => { const corpus = createCorpus(); return { ...corpus,
  entries: entriesFromRecords('owned-core14', [corpusRecord(corpus.entries)]) } }
const make = (options = {}) => new OfflineContext({ memory: fixture().memory, policy: emptyPolicy, ...options })
const changedPolicy = changes => ({ ...emptyPolicy, revision: 2, ...changes })

test('existing records yield stable exact sources/roles; memory and whole recent window remain explicit', async () => {
  const corpus = fixture(), context = make()
  const result = JSON.parse(await context.update(corpus.entries))
  assert.equal(result.memory, corpus.memory)
  assert.deepEqual(result.recent, corpus.entries.slice(-context.limits.recent))
  for (const query of corpus.queries) {
    const found = (query.needles ?? [query.needle]).flatMap(needle => context.search(needle))
    for (const id of query.expectedIds) assert.deepEqual(found.find(entry => entry.id === id), corpus.entries.find(entry => entry.id === id))
  }
  let node = context.view[0]
  while (context.nodes.get(node).count > 1) node = context.zoom(node)[0].key
  assert.deepEqual(context.zoom(node), corpus.entries[context.nodes.get(node).start])
})

test('source authority remains explicit for corrections and later conflicting tool mentions', async () => {
  const corpus = fixture(), context = make(); await context.update(corpus.entries)
  for (const query of corpus.queries.filter(query => ['correction', 'conflict'].includes(query.category))) {
    const entries = (query.needles ?? [query.needle]).flatMap(needle => context.search(needle))
    assert(query.authorityIds.length > 0)
    for (const id of query.authorityIds) assert(entries.some(entry => entry.id === id &&
      entry.message.kind === 'message' && ['user', 'system'].includes(entry.message.role)))
    assert(query.expectedIds.every(id => entries.some(entry => entry.id === id)))
    // No prototype function resolves authority or promotes a summary/latest mention to truth.
  }
})

for (const policy of ['deletion', 'disabled', 'revision', 'secret']) test(`${policy} purges summaries, descendants and derived caches before reuse`, async () => {
  const corpus = fixture(), context = make(); await context.update(corpus.entries)
  const target = corpus.entries[8]
  context.search(target.message.content.slice(0, 12))
  const before = new Map(context.nodes), encoded = context.checkpoint()
  const entries = structuredClone(corpus.entries); const rules = changedPolicy({})
  if (policy === 'deletion') rules.deleted = [target.id]
  if (policy === 'disabled') rules.disabled = [target.source.reference]
  if (policy === 'secret') rules.secrets = [target.message.content]
  if (policy === 'revision') { entries[8].source.revision = 'corrected-2'; entries[8].message.content = 'Revised source body, previous detail removed' }
  await context.update(entries, rules)
  assert(context.stats.invalidated > 0)
  assert(![...context.cache.keys()].some(key => key.startsWith('search:')))
  for (const [key, node] of before) if (node.dependencies.some(item => item.id === target.id))
    assert.notEqual(context.nodes.get(key), node)
  assert(!context.render().includes(target.message.content))
  assert(!context.checkpoint().includes(target.message.content))
  const recovered = make(); await recovered.restore(encoded, entries, rules)
  assert(!recovered.render().includes(target.message.content))
  assert(!recovered.checkpoint().includes(target.message.content))
})

test('independent token and byte constraints include metadata, memory, recent and exact retrieval', async () => {
  const corpus = fixture(), context = make({ tokenizer: { id: 'mock-double-v1', count: text => [...text].length * 2 },
    limits: { maxBytes: 10000, maxTokens: 6000, nodeTokens: 320 } })
  const result = await context.update(corpus.entries)
  assert(Buffer.byteLength(result) <= 10000 && context.tokens(result) <= 6000)
  assert.throws(() => context.search('a', { maxBytes: 1, maxTokens: 1 }), /budget/)
  assert.throws(() => context.search('a', { maxBytes: 10001 }), /budget/)
  const tooSmall = make({ limits: { maxBytes: 1, maxTokens: 1 } })
  await assert.rejects(tooSmall.update(corpus.entries), /budget/)
  assert.throws(() => tooSmall.render(), /withheld/)
  const invalidCounter = make({ tokenizer: { id: 'invalid', count: () => NaN } })
  await assert.rejects(invalidCounter.update(corpus.entries), /tokenizer/)
})

for (const [name, summarizer] of [['reject', () => { throw new Error('owned failure') }],
  ['timeout', () => new Promise(() => {})], ['oversize', () => 'z'.repeat(100000)]])
  test(`failed ${name} summarizer has bounded attempts and explicit fallback without source loss`, async () => {
    const corpus = fixture(), context = make({ summarizer, limits: { timeoutMs: 1 } })
    await context.update(corpus.entries)
    assert(context.stats.calls > 0 && context.stats.calls === context.stats.failures)
    assert(context.stats.calls <= context.nodes.size * context.limits.attempts)
    assert([...context.nodes.values()].some(node => node.fallback))
    for (const query of corpus.queries) for (const id of query.expectedIds)
      assert((query.needles ?? [query.needle]).flatMap(needle => context.search(needle)).some(entry => entry.id === id))
  })

test('versioned checkpoint preserves saved view, rejects corrupt state and recovers after failed writes', async () => {
  const corpus = fixture(), context = make(); await context.update(corpus.entries.slice(0, 32))
  const committed = context.checkpoint(), recovered = make()
  await recovered.restore(committed, corpus.entries.slice(0, 32))
  assert.equal(recovered.render(), context.render()); assert.equal(recovered.stats.calls, 0)
  await context.update(corpus.entries)
  // An owned checkpoint adapter throws before commit: the last committed bytes remain recoverable.
  const failedWrite = () => { throw new Error('owned checkpoint failure') }
  assert.throws(() => failedWrite(context.checkpoint()), /checkpoint failure/)
  await recovered.restore(committed, corpus.entries)
  assert.equal(recovered.entries.length, corpus.entries.length)
  assert.equal(recovered.render(), context.render())
  for (const encoded of ['{', JSON.stringify({ state: { version: 2 }, checksum: 'bad' }),
    committed.replace('mock-unicode', 'changed-model')]) {
    const quarantined = make()
    await assert.rejects(quarantined.restore(encoded, corpus.entries), /Quarantined/)
    assert.throws(() => quarantined.render(), /withheld/)
    await quarantined.update(corpus.entries)
    assert.equal(quarantined.entries.length, corpus.entries.length)
  }
})

test('newly screened explicit memory withholds the entire context until refreshed', async () => {
  const corpus = fixture(), context = make({ memory: 'owned screening marker' })
  await context.update(corpus.entries)
  await assert.rejects(context.update(corpus.entries, changedPolicy({ secrets: ['screening marker'] })), /memory.*screening/)
  assert.throws(() => context.render(), /withheld/)
  assert.throws(() => context.checkpoint(), /withheld/)
  const unrecognized = make({ memory: 'owned screening marker' }); await unrecognized.update(corpus.entries)
  const saved = unrecognized.checkpoint(), recovered = make({ memory: 'owned screening marker' })
  await assert.rejects(recovered.restore(saved, corpus.entries, changedPolicy({ secrets: ['screening marker'] })), /memory.*screening/)
  assert.throws(() => recovered.render(), /withheld/)
})

test('summary-only discovered secret is screened before stale state reuse or summarizer acceptance', async () => {
  const corpus = fixture(), context = make({ summarizer: () => 'synthetic-summary-screen-marker' })
  await context.update(corpus.entries); const saved = context.checkpoint()
  assert(saved.includes('synthetic-summary-screen-marker'))
  await context.update(corpus.entries, changedPolicy({ secrets: ['synthetic-summary-screen-marker'] }))
  assert(!context.checkpoint().includes('synthetic-summary-screen-marker'))
  assert(context.stats.failures > 0)
  const recovered = make({ summarizer: () => 'synthetic-summary-screen-marker' })
  await recovered.restore(saved, corpus.entries, changedPolicy({ secrets: ['synthetic-summary-screen-marker'] }))
  assert(!recovered.checkpoint().includes('synthetic-summary-screen-marker'))
})

test('decoded credential screens cover quotes, newlines, backslashes, tool metadata and restored summaries', async () => {
  for (const marker of ['owned\nmarker', 'owned"marker', 'owned\\marker']) {
    const corpus = fixture(), entries = structuredClone(corpus.entries)
    entries[8].message.content += marker
    const context = make(); await context.update(entries); const saved = context.checkpoint()
    await context.update(entries, changedPolicy({ secrets: [marker] }))
    assert(!context.entries.some(entry => entry.id === entries[8].id))
    assert.equal(context.search(marker).length, 0)
    const recovered = make(); await recovered.restore(saved, entries, changedPolicy({ secrets: [marker] }))
    assert.equal(recovered.search(marker).length, 0)
    const generated = make({ summarizer: () => marker }); await generated.update(corpus.entries)
    const generatedSaved = generated.checkpoint()
    const reloaded = make({ summarizer: () => marker })
    await reloaded.restore(generatedSaved, corpus.entries, changedPolicy({ secrets: [marker] }))
    assert(![...reloaded.nodes.values()].some(node => node.text.includes(marker)))
    const call = entries.find(entry => entry.message.kind === 'assistant' && entry.message.toolCalls.length)
    call.message.toolCalls[0].arguments.ordinaryScreenMarker = marker
    await context.update(entries, changedPolicy({ secrets: [marker] }))
    assert(!context.entries.some(entry => entry.id === call.id))
  }
})

test('large subtree zoom omits internal manifests; exact oversized leaf pages reconstruct original source', async () => {
  const corpus = fixture(), entries = structuredClone(corpus.entries)
  entries[12].message.content = '頁 / \"verbatim\" / \n'.repeat(400)
  const context = make(); await context.update(entries)
  const children = context.zoom('0+64')
  assert(children.every(child => !Object.hasOwn(child, 'dependencies')))
  assert(Buffer.byteLength(JSON.stringify(children)) <= context.limits.maxBytes)
  let page = context.zoom('12+1'), content = ''
  assert.equal(page.kind, 'source_page')
  while (true) {
    assert(Buffer.byteLength(JSON.stringify(page)) <= context.limits.maxBytes)
    assert(context.tokens(JSON.stringify(page)) <= context.limits.maxTokens)
    assert.equal(page.id, entries[12].id); assert.deepEqual(page.source, entries[12].source)
    content += page.text
    if (page.nextOffset === null) break
    page = context.zoom('12+1', { offset: page.nextOffset })
  }
  assert.deepEqual(JSON.parse(content), entries[12])
})

test('known policies survive omission and stale checkpoints; clearing requires a newer complete snapshot', async () => {
  const corpus = fixture(), target = corpus.entries[8]
  for (const change of [{ deleted: [target.id] }, { disabled: [target.source.reference] }, { secrets: [target.message.content] }]) {
    const context = make(); await context.update(corpus.entries); const old = context.checkpoint()
    const policy = changedPolicy(change); await context.update(corpus.entries, policy)
    await context.update(corpus.entries)
    assert(!context.entries.some(entry => entry.id === target.id))
    await context.restore(old, corpus.entries)
    assert(!context.entries.some(entry => entry.id === target.id))
    const current = context.checkpoint(), fresh = make()
    await assert.rejects(fresh.restore(current, corpus.entries), /policy binding/)
    const conflict = make({ policy: { ...emptyPolicy, revision: 2 } })
    await assert.rejects(conflict.restore(current, corpus.entries), /policy fingerprint/)
    assert.throws(() => conflict.render(), /withheld/)
    await fresh.restore(current, corpus.entries, policy)
    assert(!fresh.entries.some(entry => entry.id === target.id))
    await assert.rejects(context.update(corpus.entries, emptyPolicy), /policy revision/)
    await context.update(corpus.entries, { ...emptyPolicy, revision: 3 })
    assert(context.entries.some(entry => entry.id === target.id))
  }
  const missing = make({ policy: undefined })
  await assert.rejects(missing.update(corpus.entries), /policy snapshot required/)
  await assert.rejects(missing.restore('{}', corpus.entries), /policy snapshot required/)
})

test('tight injected token budgets admit only fitting fallbacks and round-trip their generated checkpoint', async () => {
  const corpus = fixture(), options = { tokenizer: { id: 'mock-double-tight-v1', count: text => [...text].length * 2 },
    summarizer: () => { throw new Error('owned failure') }, limits: { maxBytes: 10000, maxTokens: 6000, nodeTokens: 16 } }
  const context = make(options); await context.update(corpus.entries)
  assert([...context.nodes.values()].every(node => context.tokens(node.text) <= 16))
  const recovered = make(options); await recovered.restore(context.checkpoint(), corpus.entries)
  assert.equal(recovered.render(), context.render())
})

test('mock experiment compares same corpus, budgets and exact-source access without provider conclusions', async () => {
  const result = await evaluate()
  assert.deepEqual(result, await evaluate())
  assert.deepEqual(result, JSON.parse(await readFile(new URL('../docs/experiments/CORE14_MOCK_RESULTS.json', import.meta.url), 'utf8')))
  assert.equal(result.providerCalls, 0)
  assert.equal(result.providerCacheMetrics, null); assert.equal(result.actualProviderCost, null)
  assert.equal(result.actualModelQuality, null)
  assert(result.requests.hierarchy.fits && result.requests.flat.fits)
  assert(result.durability.savedViewRoundTripEqual)
  assert(result.queries.some(query => query.hierarchyViewEvidence < query.requiredEvidence))
  for (const query of result.queries) {
    assert.equal(query.hierarchyWithExactSearch, query.requiredEvidence)
    assert.equal(query.flatWithExactSearch, query.requiredEvidence)
  }
})
