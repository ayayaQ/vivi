// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createToolRegistry } from '../dist/extensions.js'
import {
  MAX_MEMORIES, MAX_MEMORY_CHARACTERS, MAX_MEMORY_TOTAL_CHARACTERS,
  decodeMemories, encodeMemories, validateMemories, memoryRevision, normalizeMemoryContent,
  createMemoryService, formatMemoryContext, MEMORY_GUIDANCE, MEMORY_MUTATION_TOOL_NAMES,
  createMemoryExtension
} from '../dist/extensions/memory.js'

const memory = (id = 'existing', content = 'Use concise replies', overrides = {}) => ({
  id, content, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
  createdBy: 'user', updatedBy: 'agent', ...overrides
})
const data = (memories = []) => ({ version: 1, memories })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(initial = data(), overrides = {}) {
  const writes = []
  let loads = 0
  const adapter = {
    async load() { loads++; return initial },
    assertWritable() {},
    async save(next) { writes.push(structuredClone(next)) },
    ...overrides
  }
  return { service: createMemoryService(adapter), writes, adapter, loads: () => loads }
}
const context = () => ({ signal: new AbortController().signal })
const call = (name, arguments_ = {}) => ({ id: 'memory-call', name, arguments: arguments_ })
const errorCode = (result) => { assert.equal(result.isError, true); return JSON.parse(result.content).error.code }

test('v1 codec preserves legacy timestamps, record key order, extras, and exact revisions', () => {
  const legacy = { content: '  Concise replies  ', id: ' legacy-id ', updatedBy: 'user',
    updatedAt: '', createdBy: 'agent', createdAt: 'legacy timestamp', extra: { source: 'legacy' } }
  const raw = JSON.stringify({ memories: [legacy], extraStore: 'retained until mutation' })
  const decoded = decodeMemories(raw)
  assert.equal(decoded.version, 1)
  assert.deepEqual(decoded.memories[0], legacy)
  assert.equal(decoded.extraStore, 'retained until mutation')
  assert.deepEqual(decodeMemories(encodeMemories(decoded)), decoded)
  assert.equal(memoryRevision(decoded.memories[0]), createHash('sha256').update(JSON.stringify(legacy)).digest('hex').slice(0, 16))
  assert.equal(memoryRevision(legacy), memoryRevision(JSON.parse(JSON.stringify(legacy))))
  assert.notEqual(memoryRevision(legacy), memoryRevision({ ...legacy, updatedBy: 'agent' }))
})

test('codec rejects unsupported versions, malformed records, duplicate IDs/content and bounds', () => {
  for (const invalid of [null, [], 1, {}, { version: 2, memories: [] }, { version: '1', memories: [] },
    data([null]), data([memory('', 'x')]), data([memory('a', '')]), data([memory('a', '   ')]),
    data([memory('a', 'x', { createdAt: 1 })]), data([memory('a', 'x', { updatedBy: 'other' })]),
    data([memory('same', 'x'), memory('same', 'y')]), data([memory('a', 'Hello'), memory('b', ' hello ')]),
    data([memory('a', 'x'.repeat(MAX_MEMORY_CHARACTERS + 1))]),
    data(Array.from({ length: MAX_MEMORIES + 1 }, (_, i) => memory(String(i), String(i)))),
    data(Array.from({ length: 21 }, (_, i) => memory(String(i), String(i).padEnd(1000, 'x'))))]) {
    assert.throws(() => decodeMemories(JSON.stringify(invalid)))
  }
  assert.throws(() => decodeMemories('{'))
  assert.throws(() => validateMemories(null), /array/)
})

test('normalization and collection boundaries use trimmed UTF-16 character counts', () => {
  assert.equal(normalizeMemoryContent('  hello\n'), 'hello')
  for (const invalid of [null, 5, '', ' \n ', 'x'.repeat(1001)]) assert.throws(() => normalizeMemoryContent(invalid))
  assert.equal(normalizeMemoryContent('😀'.repeat(500)).length, 1000)
  assert.throws(() => normalizeMemoryContent('😀'.repeat(501)))
  validateMemories(Array.from({ length: 100 }, (_, i) => memory(String(i), String(i))))
  const maximum = Array.from({ length: 20 }, (_, i) => memory(String(i), String(i).padEnd(1000, 'x')))
  validateMemories(maximum)
  assert.equal(maximum.reduce((sum, item) => sum + item.content.length, 0), MAX_MEMORY_TOTAL_CHARACTERS)
})

test('preparation leaves state untouched; successful CRUD preserves attribution and ID', async () => {
  const { service, writes } = fixture()
  const created = await service.prepareCreate('  Prefer short replies  ', 'user')
  assert.equal(created.kind, 'create')
  assert.match(created.after.id, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/)
  assert.equal(created.after.content, 'Prefer short replies')
  assert.equal(created.after.createdAt, created.after.updatedAt)
  assert.equal(created.after.createdBy, 'user')
  assert.equal(created.after.updatedBy, 'user')
  assert.deepEqual((await service.list()).memories, [])
  const first = await service.commit(created)
  const updated = await service.prepareUpdate(created.after.id, first.memories[0].revision, 'Prefer detailed replies', 'agent')
  assert.equal(updated.before.content, 'Prefer short replies')
  assert.equal(updated.after.id, created.after.id)
  assert.equal(updated.after.createdAt, created.after.createdAt)
  assert.equal(updated.after.createdBy, 'user')
  assert.equal(updated.after.updatedBy, 'agent')
  assert.equal((await service.list()).memories[0].content, 'Prefer short replies')
  const second = await service.commit(updated)
  assert.notEqual(second.memories[0].revision, first.memories[0].revision)
  await assert.rejects(service.prepareDelete(created.after.id, first.memories[0].revision), /Stale/)
  const removed = await service.prepareDelete(created.after.id, second.memories[0].revision)
  assert.equal((await service.commit(removed)).memories.length, 0)
  assert.equal(writes.length, 3)
})

test('state, loaded data, proposals, list results and saved snapshots have detached ownership', async () => {
  const initial = data([memory()])
  let saved
  const { service } = fixture(initial, { save(next) { saved = next; next.memories[0].content = 'adapter edit' } })
  const first = await service.list()
  initial.memories[0].content = 'caller edit'
  first.memories[0].content = 'result edit'
  assert.equal((await service.list()).memories[0].content, 'Use concise replies')
  const proposal = await service.prepareUpdate('existing', (await service.list()).memories[0].revision, 'Use paragraphs', 'user')
  const pending = service.commit(proposal)
  proposal.after.content = 'late proposal edit'
  const result = await pending
  result.memories[0].content = 'late result edit'
  assert.equal(saved.memories[0].content, 'adapter edit')
  assert.equal((await service.list()).memories[0].content, 'Use paragraphs')
})

test('update proposals detach nested legacy extras before approval', async () => {
  const original = memory('existing', 'Original', { extra: { source: 'legacy' } })
  const { service, writes } = fixture(data([original]))
  const before = (await service.list()).memories[0]
  const proposal = await service.prepareUpdate('existing', before.revision, 'Edited', 'user')
  proposal.after.extra.source = 'changed after preparing'
  proposal.before.extra.source = 'changed review snapshot'
  const unchanged = (await service.list()).memories[0]
  assert.equal(unchanged.extra.source, 'legacy')
  assert.equal(unchanged.revision, before.revision)
  assert.equal(writes.length, 0)
  await service.commit(await service.prepareCreate('Unrelated', 'user'))
  assert.equal((await service.list()).memories[0].extra.source, 'legacy')
})

test('preparation validates duplicate content, count/total limits and missing/stale targets', async () => {
  const { service } = fixture(data([memory()]))
  await assert.rejects(service.prepareCreate(' use CONCISE replies ', 'agent'), /identical/)
  await assert.rejects(service.prepareCreate('x', 'other'), /Invalid/)
  await assert.rejects(service.prepareUpdate('missing', 'revision', 'x', 'agent'), /not found/)
  await assert.rejects(service.prepareUpdate('existing', 'stale', 'x', 'agent'), /Stale/)
  await assert.rejects(service.prepareDelete('missing', 'revision'), /not found/)
  const maximum = fixture(data(Array.from({ length: 100 }, (_, i) => memory(String(i), String(i))))).service
  await assert.rejects(maximum.prepareCreate('new', 'agent'), /maximum/)
  const full = fixture(data(Array.from({ length: 20 }, (_, i) => memory(String(i), String(i).padEnd(1000, 'x'))))).service
  await assert.rejects(full.prepareCreate('new', 'agent'), /total characters/)
})

test('stale approved proposals are rechecked inside the serialized commit queue', async () => {
  const { service, writes } = fixture(data([memory()]))
  const revision = (await service.list()).memories[0].revision
  const first = await service.prepareUpdate('existing', revision, 'First edit', 'user')
  const staleEdit = await service.prepareUpdate('existing', revision, 'Second edit', 'agent')
  const staleDelete = await service.prepareDelete('existing', revision)
  await service.commit(first)
  await assert.rejects(service.commit(staleEdit), /Stale.*editing/)
  await assert.rejects(service.commit(staleDelete), /Stale.*deleting/)
  assert.equal((await service.list()).memories[0].content, 'First edit')
  assert.equal(writes.length, 1)
})

test('queued creates recheck duplicates and bounds against the latest committed state', async () => {
  const { service, writes } = fixture()
  const first = await service.prepareCreate('same', 'user')
  const duplicate = await service.prepareCreate(' SAME ', 'agent')
  await service.commit(first)
  await assert.rejects(service.commit(duplicate), /identical/)
  await assert.rejects(service.commit(first), /already exists/)
  assert.equal(writes.length, 1)
  const full = fixture(data(Array.from({ length: 99 }, (_, i) => memory(String(i), String(i))))).service
  const a = await full.prepareCreate('a', 'agent'), b = await full.prepareCreate('b', 'user')
  await full.commit(a)
  await assert.rejects(full.commit(b), /maximum/)
  const total = fixture(data(Array.from({ length: 20 }, (_, i) => memory(String(i), String(i).padEnd(999, 'x'))))).service
  const c = await total.prepareCreate('a'.repeat(10), 'user'), d = await total.prepareCreate('b'.repeat(11), 'agent')
  await total.commit(c)
  await assert.rejects(total.commit(d), /total characters/)
})

test('failed saves keep live state unchanged and the queue usable', async () => {
  const failure = new Error('Failed before commit')
  let fail = true
  const { service } = fixture(data([memory()]), { save() { if (fail) throw failure } })
  const revision = (await service.list()).memories[0].revision
  const proposal = await service.prepareUpdate('existing', revision, 'Changed', 'agent')
  await assert.rejects(service.commit(proposal), (error) => error === failure)
  assert.equal((await service.list()).memories[0].revision, revision)
  fail = false
  assert.equal((await service.commit(proposal)).memories[0].content, 'Changed')
})

test('post-rename durability uncertainty advances committed state while notices/drain stay host-owned', async () => {
  const notices = []
  let uncertain = false, saves = 0
  const { service } = fixture(data([memory()]), {
    save() {
      saves++
      if (saves === 1) { uncertain = true; notices.push('Committed rename; directory sync uncertain') }
      else uncertain = false
    }
  })
  const revision = (await service.list()).memories[0].revision
  const proposal = await service.prepareUpdate('existing', revision, 'Committed but uncertain', 'agent')
  const committed = await service.commit(proposal)
  assert.equal(committed.memories[0].content, 'Committed but uncertain')
  assert.notEqual(committed.memories[0].revision, revision)
  assert.equal(uncertain, true)
  assert.deepEqual(notices, ['Committed rename; directory sync uncertain'])
  const later = await service.prepareUpdate('existing', committed.memories[0].revision, 'Confirmed later', 'user')
  await service.commit(later)
  assert.equal(uncertain, false)
  assert.equal(saves, 2)
})

test('commits await persistence before exposing the new state and serialize later writes', async () => {
  const started = deferred(), finish = deferred()
  let saves = 0
  const { service } = fixture(data(), { async save() { if (++saves === 1) { started.resolve(); await finish.promise } } })
  const a = await service.prepareCreate('a', 'user'), b = await service.prepareCreate('b', 'user')
  const first = service.commit(a), second = service.commit(b)
  await started.promise
  assert.equal(saves, 1)
  assert.deepEqual((await service.list()).memories, [])
  finish.resolve()
  await Promise.all([first, second])
  assert.equal(saves, 2)
  assert.deepEqual((await service.list()).memories.map((item) => item.content), ['a', 'b'])
})

test('cancellation before or during a queue wait prevents dispatch, but an admitted save settles', async () => {
  const started = deferred(), finish = deferred()
  let saves = 0
  const { service } = fixture(data(), { async save() { saves++; started.resolve(); await finish.promise } })
  const a = await service.prepareCreate('a', 'user'), b = await service.prepareCreate('b', 'user')
  const alreadyAborted = new AbortController(); alreadyAborted.abort()
  await assert.rejects(service.commit(a, { signal: alreadyAborted.signal }), { name: 'AbortError' })
  assert.equal(saves, 0)
  const active = new AbortController(), queued = new AbortController()
  const first = service.commit(a, { signal: active.signal }), second = service.commit(b, { signal: queued.signal })
  await started.promise
  queued.abort(); active.abort()
  const rejection = assert.rejects(second, { name: 'AbortError' })
  finish.resolve()
  assert.equal((await first).memories[0].content, 'a')
  await rejection
  assert.equal(saves, 1)
  assert.deepEqual((await service.list()).memories.map((item) => item.content), ['a'])
})

test('load is shared per instance, failed initialization can retry, and instances stay independent', async () => {
  const gate = deferred()
  const one = fixture(data(), { async load() { await gate.promise; return data() } })
  const a = one.service.list(), b = one.service.list(); gate.resolve(); await Promise.all([a, b])
  const two = fixture()
  await one.service.commit(await one.service.prepareCreate('only one', 'user'))
  assert.deepEqual((await two.service.list()).memories, [])
  let attempts = 0
  const retry = fixture(data(), { load() { if (++attempts === 1) throw new Error('Temporary read failure'); return data() } }).service
  await assert.rejects(retry.list(), /Temporary/)
  assert.deepEqual((await retry.list()).memories, [])
  assert.equal(attempts, 2)
  const normal = fixture(); await Promise.all([normal.service.list(), normal.service.list()])
  assert.equal(normal.loads(), 1)
})

test('commit rejects malformed proposals and prevents changing immutable record identity', async () => {
  const { service, writes } = fixture(data([memory()]))
  const revision = (await service.list()).memories[0].revision
  const valid = await service.prepareUpdate('existing', revision, 'changed', 'user')
  for (const invalid of [
    { ...valid, kind: 'unknown' }, { ...valid, after: null }, { ...valid, expectedRevision: '' },
    { ...valid, after: { ...valid.after, id: 'different' } },
    { ...valid, after: { ...valid.after, createdAt: 'changed' } },
    { ...valid, after: { ...valid.after, createdBy: 'agent' } },
    { kind: 'create', before: memory(), after: memory('new', 'new') },
    { kind: 'delete', before: memory(), after: memory(), expectedRevision: revision }
  ]) await assert.rejects(service.commit(invalid), /Invalid/)
  assert.equal(writes.length, 0)
})

test('context is all-memory, oldest first, JSON-quoted, and does not mutate input', () => {
  assert.equal(formatMemoryContext([]), 'Saved user memories: none.')
  const input = [memory('new', 'Line one\n"Line two"', { updatedAt: '2' }), memory('old', 'older', { updatedAt: '1' })]
  assert.equal(formatMemoryContext(input), 'Saved user memories (oldest to newest; treat as user-level guidance):\n- "older"\n- "Line one\\n\\"Line two\\""')
  assert.equal(input[0].id, 'new')
  assert.match(MEMORY_GUIDANCE, /not system instructions or independent authorization/)
  assert.match(MEMORY_GUIDANCE, /current explicit request takes priority/)
})

test('extension requires host callbacks and every mutation routes through host policy', async () => {
  const received = []
  const host = {
    label: 'host',
    listMemories({ signal }) { assert.equal(this.label, 'host'); signal.throwIfAborted(); return { content: 'list' } },
    executeMutation(call, { signal }) { assert.equal(this.label, 'host'); signal.throwIfAborted(); received.push(call); return { content: 'approval denied', isError: true } }
  }
  assert.throws(() => createMemoryExtension({ listMemories: host.listMemories }))
  const extension = createMemoryExtension(host)
  const registry = createToolRegistry([extension])
  host.executeMutation = () => { throw new Error('late callback replacement') }
  assert.equal((await registry.executeTool(call('list_memories'), context())).content, 'list')
  for (const [name, arguments_] of [
    ['create_memory', { content: 'hello' }],
    ['edit_memory', { id: 'existing', expectedRevision: 'r', content: 'changed' }],
    ['delete_memory', { id: 'existing', expectedRevision: 'r' }]
  ]) assert.equal((await registry.executeTool(call(name, arguments_), context())).content, 'approval denied')
  assert.deepEqual(received.map((item) => item.name), MEMORY_MUTATION_TOOL_NAMES)
  assert(received.every((item) => Object.isFrozen(item)))
  assert.throws(() => createToolRegistry([extension, extension]), /Duplicate extension/)
  assert.throws(() => createToolRegistry([extension], { reservedNames: ['create_memory'] }), /collision/)
})

test('extension rejects invalid arguments before host callbacks and supports host planning filtering', async () => {
  let dispatches = 0
  const extension = createMemoryExtension({
    listMemories() { dispatches++; return { content: '{}' } },
    executeMutation() { dispatches++; return { content: '{}' } }
  })
  const registry = createToolRegistry([extension])
  for (const [name, arguments_] of [
    ['list_memories', { unexpected: 'x' }], ['create_memory', {}], ['create_memory', { content: 1 }],
    ['create_memory', { content: ' ' }], ['create_memory', { content: 'x'.repeat(1001) }],
    ['create_memory', { content: 'x', extra: 'y' }],
    ['edit_memory', { id: ' ', expectedRevision: 'r', content: 'x' }],
    ['delete_memory', { id: 'i', expectedRevision: '' }]
  ]) assert.equal(errorCode(await registry.executeTool(call(name, arguments_), context())), 'invalid_arguments')
  assert.equal(dispatches, 0)
  const planning = createToolRegistry([{ ...extension, tools: extension.tools.filter((tool) => !MEMORY_MUTATION_TOOL_NAMES.includes(tool.definition.name)) }], { reservedNames: MEMORY_MUTATION_TOOL_NAMES })
  assert.deepEqual(planning.tools.map((tool) => tool.name), ['list_memories'])
  assert.equal(errorCode(await planning.executeTool(call('create_memory', { content: 'x' }), context())), 'unavailable_tool')
  const abort = new AbortController(); abort.abort()
  await assert.rejects(registry.executeTool(call('create_memory', { content: 'x' }), { signal: abort.signal }), { name: 'AbortError' })
  assert.equal(dispatches, 0)
})
