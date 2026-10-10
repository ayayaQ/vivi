// SPDX-License-Identifier: Apache-2.0
// Deterministic structural evidence availability. This never grades generated model answers.
import { createCorpus } from './hierarchical-context-corpus.mjs'
import { OfflineContext, FlatArrivalContext, entriesFromRecords, flatCompaction, mockTokenizer, commonPrefixBytes, emptyPolicy } from './hierarchical-context.mjs'

const bytes = value => Buffer.byteLength(value)
const encodedQuote = quote => JSON.stringify(quote).slice(1, -1)
export function corpusRecord(entries) {
  return { version: 1, type: 'session_snapshot', reason: 'legacy_import', sessionId: 'owned-core14',
    eventId: 'owned-core14-import', sequence: 1, previousEventId: null,
    source: { reference: 'synthetic://core14/record', revision: '1' }, snapshot: {
      history: entries, outcomes: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } }
}

export async function evaluate() {
  const corpus = createCorpus()
  const entries = entriesFromRecords('owned-core14', [corpusRecord(corpus.entries)])
  const options = { memory: corpus.memory, policy: emptyPolicy }
  const hierarchy = new OfflineContext(options)
  const flatArrival = new FlatArrivalContext(options)
  const prefixes = [], flatPrefixes = []; let prior = '', priorFlat = ''
  // Incremental arrivals preserve a saved view. This is not a one-shot optimal refit.
  for (let count = 1; count <= entries.length; count++) {
    const rendered = await hierarchy.update(entries.slice(0, count))
    const renderedFlat = await flatArrival.update(entries.slice(0, count))
    if (prior) prefixes.push({ bytes: commonPrefixBytes(prior, rendered), previousBytes: bytes(prior) })
    if (priorFlat) flatPrefixes.push({ bytes: commonPrefixBytes(priorFlat, renderedFlat), previousBytes: bytes(priorFlat) })
    prior = rendered
    priorFlat = renderedFlat
  }
  const flat = await flatCompaction(options, entries)
  const full = JSON.stringify({ memory: corpus.memory, history: entries })
  const queries = corpus.queries.map(query => {
    const expected = query.expected
    const available = rendered => expected.filter(item => rendered.includes(encodedQuote(item.quote))).length
    const needles = query.needles ?? [query.needle]
    const retrieved = [...new Map(needles.flatMap(needle => hierarchy.search(needle)).map(entry => [entry.id, entry])).values()]
    const exactSupport = expected.filter(item => retrieved.some(entry => entry.id === item.id &&
      entry.message.content.includes(item.quote))).length
    // Same exact-source search offered to flat comparator; source access is not credited to hierarchy.
    return { id: query.id, category: query.category, requiredEvidence: expected.length,
      hierarchyViewEvidence: available(prior), flatViewEvidence: available(priorFlat),
      flatOneShotRebuildEvidence: available(flat.text), fullHistoryEvidence: available(full),
      hierarchyWithExactSearch: exactSupport, flatWithExactSearch: exactSupport,
      sourceRoles: retrieved.map(entry => ({ id: entry.id, role: entry.message.kind === 'message'
        ? entry.message.role : entry.message.kind === 'assistant' ? 'assistant' : 'tool', source: entry.source })),
      authorityIds: query.authorityIds }
  })
  const recovered = new OfflineContext(options)
  await recovered.restore(hierarchy.checkpoint(), entries)
  return { schemaVersion: 1, qualification: 'owned synthetic corpus; prefix-only mock; structural source-support availability only',
    providerCalls: 0, providerCacheMetrics: null, actualProviderCost: null, actualModelQuality: null,
    tokenizer: mockTokenizer.id, corpusEntries: entries.length, queryCount: queries.length,
    limits: hierarchy.limits, queries,
    requests: { hierarchy: { bytes: bytes(prior), mockTokens: mockTokenizer.count(prior), fits: hierarchy.fits(prior) },
      flat: { bytes: bytes(priorFlat), mockTokens: mockTokenizer.count(priorFlat), fits: hierarchy.fits(priorFlat) },
      flatOneShotRebuild: { bytes: bytes(flat.text), mockTokens: mockTokenizer.count(flat.text), fits: hierarchy.fits(flat.text) },
      unchangedFullHistory: { bytes: bytes(full), mockTokens: mockTokenizer.count(full), fits: hierarchy.fits(full) } },
    summaryWork: { hierarchy: hierarchy.stats, flat: flatArrival.stats, flatOneShotRebuild: flat.stats,
      explanation: 'Mock input/output token work and call counts; dollars and provider latency are unmeasured. Sequential calls are a latency proxy, not milliseconds.' },
    bytePrefix: { hierarchy: { commonBytes: prefixes.reduce((sum, row) => sum + row.bytes, 0),
      possibleBytes: prefixes.reduce((sum, row) => sum + row.previousBytes, 0) },
      flat: { commonBytes: flatPrefixes.reduce((sum, row) => sum + row.bytes, 0),
        possibleBytes: flatPrefixes.reduce((sum, row) => sum + row.previousBytes, 0) },
      explanation: 'Local serialized byte equality only; no tokenizer-prefix or provider cache-hit claim.' },
    durability: { savedViewRoundTripEqual: recovered.render() === hierarchy.render(),
      explanation: 'Bounded JSON checksum and current-source revalidation; physical locking/fsync/atomic commit and production recovery remain host-owned.' } }
}
