// SPDX-License-Identifier: Apache-2.0
// CORE-14 offline prototype only. No provider, tool dispatch, host integration or public export.
import { createHash } from 'node:crypto'
import { projectAgentRecords } from '../../dist/events.js'

const bytes = text => Buffer.byteLength(text, 'utf8')
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const clone = value => structuredClone(value)
const check = (condition, message) => { if (!condition) throw new Error(message) }
const role = entry => entry.message.kind === 'message' ? entry.message.role
  : entry.message.kind === 'assistant' ? 'assistant' : 'tool'
const text = entry => entry.message.content
const manifest = entries => entries.map(entry => ({ id: entry.id, fingerprint: hash(entry) }))
const containsSecret = (value, secrets) => {
  const pending = [value]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string' && secrets.some(secret => item.includes(secret))) return true
    if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) pending.push(key, child)
    }
  }
  return false
}

// This is a named mock model's tokenizer, NOT an actual provider tokenizer or token estimate.
// A caller must supply its model-specific counter. Counting complete rendered requests is mandatory.
export const mockTokenizer = Object.freeze({ id: 'mock-unicode-codepoints-v1', count: text => [...text].length })
export const defaultLimits = Object.freeze({ maxBytes: 6000, maxTokens: 6000, recent: 4,
  nodeBytes: 160, nodeTokens: 160, sourceBytes: 16000, stateBytes: 1024 * 1024,
  summaryInputTokens: 32768, entries: 256, attempts: 2, timeoutMs: 20 })
export const emptyPolicy = Object.freeze({ revision: 1, disabled: Object.freeze([]), deleted: Object.freeze([]), secrets: Object.freeze([]) })

export function entriesFromRecords(sessionId, records) {
  // Existing complete-chain projection supplies original stable IDs and role/source provenance.
  // This experiment does not rewrite events, promote a shadow ledger or replay operations.
  return clone(projectAgentRecords(sessionId, records).history)
}

export function prefixOnlySummarizer({ input, maxBytes }) {
  // Deliberately lossy, deterministic, and ignorant of query ground truth.
  let result = input.replace(/\s+/gu, ' ').trim()
  while (bytes(result) > maxBytes) result = result.slice(0, -1)
  return result
}

export class OfflineContext {
  constructor({ memory, tokenizer = mockTokenizer, summarizer = prefixOnlySummarizer, limits = {}, policy }) {
    this.limits = { ...defaultLimits, ...limits }
    for (const value of Object.values(this.limits)) check(Number.isSafeInteger(value) && value > 0, 'Invalid experiment limits')
    check(this.limits.entries <= 256 && this.limits.attempts <= 3 && this.limits.timeoutMs <= 1000 &&
      this.limits.stateBytes <= 1024 * 1024 && this.limits.nodeBytes >= 16 && this.limits.nodeTokens >= 16,
      'Experiment hard limit exceeded')
    check(typeof memory === 'string' && typeof summarizer === 'function' &&
      typeof tokenizer.id === 'string' && typeof tokenizer.count === 'function', 'Invalid experiment dependencies')
    this.memory = memory; this.tokenizer = tokenizer; this.summarizer = summarizer
    this.blocked = true
    this.secrets = []
    this.entries = []; this.nodes = new Map(); this.view = []; this.cache = new Map()
    this.stats = { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, batches: 0, invalidated: 0 }
    if (policy !== undefined) this.acceptPolicy(policy)
  }

  acceptPolicy(input) {
    if (input === undefined) { check(this.policy, 'Explicit current policy snapshot required'); return this.policy }
    check(input && Object.keys(input).length === 4 && Number.isSafeInteger(input.revision) && input.revision > 0 &&
      ['disabled', 'deleted', 'secrets'].every(key => Array.isArray(input[key]) && input[key].length <= this.limits.entries &&
        input[key].every(value => typeof value === 'string' && value.length > 0 && bytes(value) <= this.limits.sourceBytes)),
      'Invalid complete current policy snapshot')
    check(!this.policy || input.revision > this.policy.revision ||
      (input.revision === this.policy.revision && hash(input) === hash(this.policy)), 'Stale or conflicting current policy revision')
    this.policy = clone(input)
    return this.policy
  }

  tokens(value) {
    const count = this.tokenizer.count(value)
    check(Number.isSafeInteger(count) && count >= 0, 'Invalid tokenizer result')
    return count
  }

  fits(value, maxBytes = this.limits.maxBytes, maxTokens = this.limits.maxTokens) {
    return bytes(value) <= maxBytes && this.tokens(value) <= maxTokens
  }

  envelope(old = this.view.map(key => this.nodes.get(key))) {
    return JSON.stringify({ memory: this.memory, older: old.map(node => ({ key: node.key,
      text: node.text, roles: node.roles, fallback: node.fallback })), recent: this.entries.slice(-this.limits.recent) })
  }

  async summarize(input, bounds = {}) {
    check(bytes(input) <= this.limits.sourceBytes * 2 && this.tokens(input) <= this.limits.summaryInputTokens,
      'Summary input budget exceeded')
    const maxBytes = bounds.maxBytes ?? this.limits.nodeBytes, maxTokens = bounds.maxTokens ?? this.limits.nodeTokens
    check(maxBytes >= 16 && maxTokens >= 16, 'Insufficient summary headroom')
    for (let attempt = 0; attempt < this.limits.attempts; attempt++) {
      this.stats.calls++; this.stats.inputTokens += this.tokens(input)
      let timer
      try {
        const output = await Promise.race([
          Promise.resolve().then(() => this.summarizer({ input, maxBytes,
            maxTokens, tokenizerId: this.tokenizer.id })),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Summary timeout')), this.limits.timeoutMs) })
        ])
        check(typeof output === 'string' && output.length > 0 &&
          this.fits(output, maxBytes, maxTokens) && !this.secrets.some(secret => output.includes(secret)),
          'Invalid, screened or oversized summary')
        this.stats.outputTokens += this.tokens(output)
        return { text: output, fallback: false }
      } catch { this.stats.failures++ } finally { clearTimeout(timer) }
    }
    // No truncated source becomes alleged evidence. Search/zoom remain available from exact sources.
    const fallback = ['[unavailable]', '[failed]', '?'].find(text => this.fits(text, maxBytes, maxTokens) &&
      !this.secrets.some(secret => text.includes(secret)))
    check(fallback, 'Explicit fallback cannot fit summary budget; context withheld')
    return { text: fallback, fallback: true }
  }

  async node(start, count) {
    const key = `${start}+${count}`
    if (this.nodes.has(key)) return this.nodes.get(key)
    const covered = this.entries.slice(start, start + count)
    const children = count === 1 ? [] : [await this.node(start, count / 2), await this.node(start + count / 2, count / 2)]
    const input = count === 1 ? `${role(covered[0])}: ${text(covered[0])}`
      : children.map(child => child.text).join('\n')
    const summary = this.fits(input, this.limits.nodeBytes, this.limits.nodeTokens)
      ? { text: input, fallback: children.some(child => child.fallback) } : await this.summarize(input)
    const result = { key, start, count, children: children.map(child => child.key),
      dependencies: manifest(covered), roles: [...new Set(covered.map(role))], ...summary }
    this.nodes.set(key, result)
    return result
  }

  async update(entries, policy) {
    this.blocked = true; this.cache.clear()
    const { disabled, deleted, secrets } = this.acceptPolicy(policy)
    check(Array.isArray(entries) && entries.length <= this.limits.entries, 'Source count limit exceeded')
    check(new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate source identity')
    check(entries.every(entry => typeof entry.id === 'string' && typeof entry.source?.reference === 'string' &&
      typeof entry.message?.content === 'string' && bytes(JSON.stringify(entry)) <= this.limits.sourceBytes), 'Invalid or oversized source')
    check(secrets.every(secret => typeof secret === 'string' && secret.length > 0), 'Invalid secret screen')
    check(!secrets.some(secret => this.memory.includes(secret)), 'Explicit memory requires current source screening')
    this.secrets = clone(secrets)
    // Screen complete source envelopes before summarization, exact retrieval, recent context or state reuse.
    const current = clone(entries.filter(entry => !disabled.includes(entry.source.reference) &&
      !deleted.includes(entry.id) && !containsSecret(entry, secrets)))
    const previous = manifest(this.entries), next = manifest(current)
    const map = new Map(next.map(item => [item.id, item.fingerprint]))
    const changed = new Set(previous.filter(item => map.get(item.id) !== item.fingerprint).map(item => item.id))
    const affected = [...this.nodes.values()].filter(node => node.dependencies.some(item => changed.has(item.id)))
    const remove = new Set()
    const descend = key => { if (remove.has(key)) return; remove.add(key); this.nodes.get(key)?.children.forEach(descend) }
    affected.forEach(node => descend(node.key))
    // Conservatively purge related descendants, then clear all derived query/context caches before reuse.
    remove.forEach(key => this.nodes.delete(key)); this.stats.invalidated += remove.size
    if (secrets.length) { this.stats.invalidated += this.nodes.size; this.nodes.clear(); this.view = [] }
    if (changed.size) this.cache.clear()
    const isAppend = previous.every((item, index) => next[index]?.id === item.id && next[index]?.fingerprint === item.fingerprint)
    if (!isAppend) { this.nodes.clear(); this.view = []; this.cache.clear() }
    this.entries = current
    const olderCount = Math.max(0, current.length - this.limits.recent)
    let covered = this.view.reduce((sum, key) => sum + this.nodes.get(key).count, 0)
    for (; covered < olderCount; covered++) this.view.push((await this.node(covered, 1)).key)
    // Build parents once; only change the saved view when a complete request would overflow.
    for (let size = 2; size <= olderCount; size *= 2)
      for (let start = 0; start + size <= olderCount; start += size) await this.node(start, size)
    check(this.fits(this.envelope([])), 'Whole recent window or explicit memory exceeds request budget')
    if (!this.fits(this.envelope())) {
      this.stats.batches++
      while (true) {
        const candidates = []
        for (let i = 0; i + 1 < this.view.length; i++) {
          const left = this.nodes.get(this.view[i]), right = this.nodes.get(this.view[i + 1])
          if (left.count === right.count && left.start % (2 * left.count) === 0 && right.start === left.start + left.count)
            candidates.push({ i, due: (olderCount - right.start - right.count) / left.count, start: left.start, count: left.count * 2 })
        }
        if (!candidates.length) break
        candidates.sort((a, b) => b.due - a.due || a.start - b.start)
        const chosen = candidates[0]
        this.view.splice(chosen.i, 2, `${chosen.start}+${chosen.count}`)
        if (bytes(this.envelope()) <= this.limits.maxBytes * 0.65 && this.tokens(this.envelope()) <= this.limits.maxTokens * 0.65) break
      }
    }
    check(this.fits(this.envelope()), 'Summary view cannot fit request budget; exact source state retained')
    this.cache.set('context', { dependencies: manifest(this.entries), value: this.envelope() })
    this.blocked = false
    return this.render()
  }

  render() {
    check(!this.blocked, 'Context withheld until a valid current source update')
    const output = this.envelope()
    check(this.fits(output), 'Context budget exceeded')
    return output
  }

  search(needle, { maxBytes = this.limits.maxBytes, maxTokens = this.limits.maxTokens } = {}) {
    check(!this.blocked && maxBytes <= this.limits.maxBytes && maxTokens <= this.limits.maxTokens, 'Retrieval budget or state invalid')
    check(typeof needle === 'string' && needle.length > 0 && bytes(needle) <= 256, 'Invalid exact-source search')
    const result = this.entries.filter(entry => text(entry).includes(needle))
    check(this.fits(JSON.stringify(result), maxBytes, maxTokens), 'Exact-source retrieval budget exceeded')
    this.cache.set(`search:${needle}`, { dependencies: manifest(result), value: clone(result) })
    return clone(result)
  }

  zoom(key, options = {}) {
    check(!this.blocked && (options.maxBytes ?? this.limits.maxBytes) <= this.limits.maxBytes &&
      (options.maxTokens ?? this.limits.maxTokens) <= this.limits.maxTokens, 'Retrieval budget or state invalid')
    const node = this.nodes.get(key)
    check(node, 'Unavailable summary')
    const maxBytes = options.maxBytes ?? this.limits.maxBytes, maxTokens = options.maxTokens ?? this.limits.maxTokens
    const result = node.count === 1 ? clone(this.entries[node.start])
      : node.children.map(child => {
        const { key, start, count, text, roles, fallback } = this.nodes.get(child)
        return { key, start, count, text, roles: clone(roles), fallback }
      })
    if (node.count === 1 && (options.offset !== undefined || !this.fits(JSON.stringify(result), maxBytes, maxTokens))) {
      const content = [...JSON.stringify(result)], offset = options.offset ?? 0
      check(Number.isSafeInteger(offset) && offset >= 0 && offset < content.length, 'Invalid source page offset')
      const page = end => ({ kind: 'source_page', id: result.id, source: result.source, role: role(result),
        offset, text: content.slice(offset, end).join(''), nextOffset: end < content.length ? end : null,
        totalCodepoints: content.length })
      let low = offset, high = content.length
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        if (this.fits(JSON.stringify(page(mid)), maxBytes, maxTokens)) low = mid; else high = mid - 1
      }
      check(low > offset, 'Exact-source page metadata exceeds retrieval budget')
      return page(low)
    }
    check(this.fits(JSON.stringify(result), maxBytes, maxTokens), 'Exact-source retrieval budget exceeded')
    return result
  }

  checkpoint() {
    check(!this.blocked, 'Context withheld until a valid current source update')
    const state = { version: 1, tokenizerId: this.tokenizer.id, memoryHash: hash(this.memory), limits: this.limits,
      policy: { revision: this.policy.revision, fingerprint: hash(this.policy) },
      manifest: manifest(this.entries), nodes: [...this.nodes.values()], view: this.view }
    const encoded = JSON.stringify({ state, checksum: hash(state) })
    check(bytes(encoded) <= this.limits.stateBytes, 'Checkpoint byte budget exceeded')
    return encoded
  }

  async restore(encoded, currentEntries, policy) {
    this.blocked = true; this.cache.clear()
    const currentPolicy = this.acceptPolicy(policy), { disabled, deleted, secrets } = currentPolicy
    check(secrets.every(secret => typeof secret === 'string' && secret.length > 0), 'Invalid secret screen')
    check(!secrets.some(secret => this.memory.includes(secret)), 'Explicit memory requires current source screening')
    this.secrets = clone(secrets)
    check(typeof encoded === 'string' && bytes(encoded) <= this.limits.stateBytes, 'Checkpoint byte budget exceeded')
    let saved
    try { saved = JSON.parse(encoded) } catch { throw new Error('Quarantined corrupt checkpoint; authoritative sources required') }
    check(saved?.state?.version === 1 && saved.checksum === hash(saved.state) &&
      saved.state.tokenizerId === this.tokenizer.id && saved.state.memoryHash === hash(this.memory) &&
      JSON.stringify(saved.state.limits) === JSON.stringify(this.limits), 'Quarantined incompatible checkpoint; authoritative sources required')
    const state = saved.state
    check(state.policy && Number.isSafeInteger(state.policy.revision) && state.policy.revision > 0 &&
      /^[a-f0-9]{64}$/.test(state.policy.fingerprint) && currentPolicy.revision >= state.policy.revision,
      'Quarantined stale or invalid current policy binding')
    check(currentPolicy.revision !== state.policy.revision || hash(currentPolicy) === state.policy.fingerprint,
      'Quarantined conflicting current policy fingerprint')
    check(Array.isArray(state.manifest) && Array.isArray(state.nodes) && Array.isArray(state.view) &&
      state.manifest.length <= this.limits.entries && state.nodes.length <= this.limits.entries * 2 &&
      state.view.length <= this.limits.entries, 'Quarantined invalid checkpoint structure')
    const safe = currentEntries.filter(entry => !disabled.includes(entry.source.reference) &&
      !deleted.includes(entry.id) && !containsSecret(entry, secrets))
    // A changed source/policy rebuilds; saved summaries containing deleted text are never exposed.
    if (JSON.stringify(manifest(safe)) !== JSON.stringify(state.manifest) ||
      hash(currentPolicy) !== state.policy.fingerprint || containsSecret(state.nodes, secrets))
      return this.update(currentEntries, currentPolicy)
    const nodes = new Map(state.nodes.map(node => [node.key, node]))
    check(nodes.size === state.nodes.length, 'Quarantined duplicate nodes')
    for (const node of state.nodes) {
      check(Number.isSafeInteger(node.start) && Number.isSafeInteger(node.count) && node.start >= 0 && node.count > 0 &&
        (node.count & (node.count - 1)) === 0 && node.start % node.count === 0 && node.start + node.count <= safe.length &&
        node.key === `${node.start}+${node.count}` && typeof node.text === 'string' && typeof node.fallback === 'boolean' &&
        this.fits(node.text, this.limits.nodeBytes, this.limits.nodeTokens) &&
        JSON.stringify(node.dependencies) === JSON.stringify(manifest(safe.slice(node.start, node.start + node.count))) &&
        JSON.stringify(node.roles) === JSON.stringify([...new Set(safe.slice(node.start, node.start + node.count).map(role))]) &&
        JSON.stringify(node.children) === JSON.stringify(node.count === 1 ? [] :
          [`${node.start}+${node.count / 2}`, `${node.start + node.count / 2}+${node.count / 2}`]) &&
        node.children.every(child => nodes.has(child)), 'Quarantined invalid summary dependency')
    }
    let cursor = 0
    for (const key of state.view) { const node = nodes.get(key); check(node?.start === cursor, 'Quarantined invalid saved view'); cursor += node.count }
    check(cursor === Math.max(0, safe.length - this.limits.recent), 'Quarantined incomplete saved view')
    this.entries = clone(safe); this.nodes = nodes; this.view = clone(state.view); this.cache.clear()
    this.blocked = false
    return this.render()
  }
}

// Fair reference comparator: same sources, memory, recent window, tokenizer and summary callback.
// It is ordinary flat compaction for this experiment, not an existing shipped Vivi summarizer.
export async function flatCompaction(options, entries) {
  const context = new OfflineContext(options)
  const older = entries.slice(0, -context.limits.recent)
  const fixed = JSON.stringify({ memory: options.memory, older: { text: '', fallback: false }, recent: entries.slice(-context.limits.recent) })
  const summary = await context.summarize(older.map(entry => `${role(entry)}: ${text(entry)}`).join('\n'),
    { maxBytes: context.limits.maxBytes - bytes(fixed) - 128, maxTokens: context.limits.maxTokens - context.tokens(fixed) - 128 })
  const result = JSON.stringify({ memory: options.memory, older: summary, recent: entries.slice(-context.limits.recent) })
  check(context.fits(result), 'Flat compaction request exceeds budget')
  return { text: result, stats: context.stats }
}

// Ordinary incremental flat compaction: same arrivals/recent window/high-to-low batching.
// It summarizes its current older view, not an oracle-selected answer or recovered original detail.
// Exact original records remain equally searchable outside both compressed representations.
export class FlatArrivalContext {
  constructor(options) {
    this.counter = new OfflineContext(options); this.entries = []; this.lines = []
    this.stats = this.counter.stats
  }
  envelope(lines = this.lines) {
    return JSON.stringify({ memory: this.counter.memory, older: lines, recent: this.entries.slice(-this.counter.limits.recent) })
  }
  async update(entries) {
    const previousOlder = Math.max(0, this.entries.length - this.counter.limits.recent)
    this.entries = clone(entries)
    for (let index = previousOlder; index < entries.length - this.counter.limits.recent; index++) {
      const entry = entries[index]
      this.lines.push({ key: `${index}+1`, text: `${role(entry)}: ${text(entry)}`, roles: [role(entry)] })
    }
    if (!this.counter.fits(this.envelope())) {
      this.stats.batches++
      const fixed = this.envelope([{ key: 'flat', text: '', roles: [], fallback: false }])
      const summary = await this.counter.summarize(this.lines.map(line => line.text).join('\n'), {
        maxBytes: Math.floor(this.counter.limits.maxBytes * 0.65) - bytes(fixed) - 128,
        maxTokens: Math.floor(this.counter.limits.maxTokens * 0.65) - this.counter.tokens(fixed) - 128 })
      this.lines = [{ key: 'flat', ...summary, roles: [...new Set(this.lines.flatMap(line => line.roles))] }]
    }
    check(this.counter.fits(this.envelope()), 'Flat arrival request exceeds budget')
    return this.envelope()
  }
}

export function commonPrefixBytes(left, right) {
  const a = Buffer.from(left), b = Buffer.from(right); let index = 0
  while (index < Math.min(a.length, b.length) && a[index] === b[index]) index++
  return index // Byte equality only: never a provider cache-hit metric.
}
