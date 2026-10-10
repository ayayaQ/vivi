// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createCorpus } from './fixtures/hierarchical-context-corpus.mjs'
import { OfflineContext, mockTokenizer, entriesFromRecords } from './fixtures/hierarchical-context.mjs'
import { corpusRecord, evaluate } from './fixtures/hierarchical-context-evaluation.mjs'

const fixture = () => { const corpus = createCorpus(); return { ...corpus,
  entries: entriesFromRecords('owned-core14', [corpusRecord(corpus.entries)]) } }
const make = (options = {}) => new OfflineContext({ memory: fixture().memory, ...options })

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
  const entries = structuredClone(corpus.entries); const rules = {}
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
  await assert.rejects(context.update(corpus.entries, { secrets: ['screening marker'] }), /memory.*screening/)
  assert.throws(() => context.render(), /withheld/)
  assert.throws(() => context.checkpoint(), /withheld/)
  const unrecognized = make({ memory: 'owned screening marker' }); await unrecognized.update(corpus.entries)
  const saved = unrecognized.checkpoint(), recovered = make({ memory: 'owned screening marker' })
  await assert.rejects(recovered.restore(saved, corpus.entries, { secrets: ['screening marker'] }), /memory.*screening/)
  assert.throws(() => recovered.render(), /withheld/)
})

test('summary-only discovered secret is screened before stale state reuse or summarizer acceptance', async () => {
  const corpus = fixture(), context = make({ summarizer: () => 'synthetic-summary-screen-marker' })
  await context.update(corpus.entries); const saved = context.checkpoint()
  assert(saved.includes('synthetic-summary-screen-marker'))
  await context.update(corpus.entries, { secrets: ['synthetic-summary-screen-marker'] })
  assert(!context.checkpoint().includes('synthetic-summary-screen-marker'))
  assert(context.stats.failures > 0)
  const recovered = make({ summarizer: () => 'synthetic-summary-screen-marker' })
  await recovered.restore(saved, corpus.entries, { secrets: ['synthetic-summary-screen-marker'] })
  assert(!recovered.checkpoint().includes('synthetic-summary-screen-marker'))
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
