// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto'
import type { ToolExtension } from '../extensions.js'
import type { JsonObject, ToolCall, ToolResult } from '../types.js'

export const MAX_MEMORIES = 100
export const MAX_MEMORY_CHARACTERS = 1_000
export const MAX_MEMORY_TOTAL_CHARACTERS = 20_000

export type MemoryActor = 'agent' | 'user'

export interface Memory {
  id: string
  content: string
  createdAt: string
  updatedAt: string
  createdBy: MemoryActor
  updatedBy: MemoryActor
}

export interface MemoryWithRevision extends Memory { revision: string }
export interface MemoriesData { version: 1; memories: Memory[] }
export interface MemoryListResult {
  memories: MemoryWithRevision[]
  limits: {
    maximumMemories: number
    maximumMemoryCharacters: number
    maximumTotalCharacters: number
  }
}

/** A reviewable proposal, not authorization. Commit only after host policy permits it. */
export type MemoryMutation =
  | { kind: 'create'; before: null; after: Memory }
  | { kind: 'update'; before: Memory; after: Memory; expectedRevision: string }
  | { kind: 'delete'; before: Memory; after: null; expectedRevision: string }

/**
 * The host owns files, recovery, notices, writability, durability and operation admission/drain.
 * load may checkpoint recovered data before returning. save must resolve only on a committed
 * write. Reject only before the commit boundary, preserving the original error. After a rename
 * commits, resolve even if directory-sync durability is uncertain: the host must report that
 * uncertainty and retain its own retry/drain obligations. It must not imply rollback.
 */
export interface MemoryPersistence {
  load(): MemoriesData | Promise<MemoriesData>
  assertWritable(): void
  save(data: MemoriesData): void | Promise<void>
}

export interface MemoryService {
  list(): Promise<MemoryListResult>
  prepareCreate(content: string, actor: MemoryActor): Promise<MemoryMutation>
  prepareUpdate(id: string, expectedRevision: string, content: string, actor: MemoryActor): Promise<MemoryMutation>
  prepareDelete(id: string, expectedRevision: string): Promise<MemoryMutation>
  /** Serializes this instance only. The host must admit the operation before calling commit. */
  commit(mutation: MemoryMutation, options?: { readonly signal?: AbortSignal }): Promise<MemoryListResult>
}

function clone<T>(value: T): T { return structuredClone(value) }
function isActor(value: unknown): value is MemoryActor { return value === 'agent' || value === 'user' }

export function normalizeMemoryContent(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Memory content must be text')
  const content = value.trim()
  if (!content) throw new Error('Memory content cannot be empty')
  if (content.length > MAX_MEMORY_CHARACTERS) {
    throw new Error(`Memory content cannot exceed ${MAX_MEMORY_CHARACTERS} characters`)
  }
  return content
}

function validMemory(value: unknown): value is Memory {
  if (!value || typeof value !== 'object') return false
  const memory = value as Memory
  return typeof memory.id === 'string' && memory.id.trim().length > 0 &&
    typeof memory.content === 'string' && memory.content.trim().length > 0 &&
    memory.content.length <= MAX_MEMORY_CHARACTERS &&
    typeof memory.createdAt === 'string' && typeof memory.updatedAt === 'string' &&
    isActor(memory.createdBy) && isActor(memory.updatedBy)
}

export function validateMemories(memories: readonly Memory[]): void {
  if (!Array.isArray(memories)) throw new Error('Memories must be an array')
  if (memories.length > MAX_MEMORIES) {
    throw new Error(`A maximum of ${MAX_MEMORIES} memories can be stored`)
  }
  const seen = new Set<string>()
  const ids = new Set<string>()
  let totalCharacters = 0
  for (const memory of memories) {
    if (!validMemory(memory) || ids.has(memory.id)) throw new Error('Invalid memory record or duplicate ID')
    ids.add(memory.id)
    totalCharacters += memory.content.length
    const key = memory.content.trim().toLocaleLowerCase()
    if (seen.has(key)) throw new Error('An identical memory already exists')
    seen.add(key)
  }
  if (totalCharacters > MAX_MEMORY_TOTAL_CHARACTERS) {
    throw new Error(`Memories cannot exceed ${MAX_MEMORY_TOTAL_CHARACTERS} total characters`)
  }
}

/** Preserve the desktop v1 algorithm, including property order and extra stored record fields. */
export function memoryRevision(memory: Memory): string {
  return createHash('sha256').update(JSON.stringify(memory)).digest('hex').slice(0, 16)
}

/** v1 compatibility: omitted version and string-only timestamps remain accepted. */
export function decodeMemories(raw: string): MemoriesData {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Agent memory store must be an object')
  }
  const collection = parsed as Partial<MemoriesData>
  if ((collection.version !== undefined && collection.version !== 1) || !Array.isArray(collection.memories)) {
    throw new Error('Invalid or unsupported agent memory store')
  }
  validateMemories(collection.memories)
  return { ...collection, version: 1, memories: collection.memories }
}

export function encodeMemories(data: MemoriesData): string {
  // Validate without rebuilding records, which would change legacy revision bytes.
  decodeMemories(JSON.stringify(data))
  return JSON.stringify(data)
}

/** Instance-local domain state; no path selection, filesystem access or cross-process lock. */
export function createMemoryService(persistence: MemoryPersistence): MemoryService {
  // Capture methods once, but retain the adapter receiver for class-based host adapters.
  const load = persistence.load.bind(persistence)
  const assertWritable = persistence.assertWritable.bind(persistence)
  const save = persistence.save.bind(persistence)
  let data: MemoriesData | undefined
  let loading: Promise<void> | undefined
  let mutationChain: Promise<unknown> = Promise.resolve()

  async function initialize(): Promise<void> {
    if (data) return
    if (!loading) {
      loading = Promise.resolve().then(load).then((stored) => {
        // The host uses decodeMemories for legacy version migration before handing us data.
        if (!stored || stored.version !== 1) throw new Error('Invalid or unsupported agent memory store')
        validateMemories(stored.memories)
        data = clone(stored)
      }).catch((error: unknown) => { loading = undefined; throw error })
    }
    await loading
  }

  function listResult(): MemoryListResult {
    return {
      memories: data!.memories.map((memory) => ({ ...clone(memory), revision: memoryRevision(memory) })),
      limits: {
        maximumMemories: MAX_MEMORIES,
        maximumMemoryCharacters: MAX_MEMORY_CHARACTERS,
        maximumTotalCharacters: MAX_MEMORY_TOTAL_CHARACTERS
      }
    }
  }

  return {
    async list() { await initialize(); return listResult() },
    async prepareCreate(content, actor) {
      await initialize()
      assertWritable()
      const timestamp = new Date().toISOString()
      const memory: Memory = {
        id: randomUUID(), content: normalizeMemoryContent(content),
        createdAt: timestamp, updatedAt: timestamp, createdBy: actor, updatedBy: actor
      }
      validateMemories([...data!.memories, memory])
      return { kind: 'create', before: null, after: memory }
    },
    async prepareUpdate(id, expectedRevision, content, actor) {
      await initialize()
      assertWritable()
      const before = data!.memories.find((memory) => memory.id === id)
      if (!before) throw new Error('Memory not found')
      if (memoryRevision(before) !== expectedRevision) throw new Error('Stale memory revision; refresh memories before editing')
      const after: Memory = {
        ...clone(before), content: normalizeMemoryContent(content), updatedAt: new Date().toISOString(), updatedBy: actor
      }
      validateMemories(data!.memories.map((memory) => memory.id === id ? after : memory))
      return { kind: 'update', before: clone(before), after, expectedRevision }
    },
    async prepareDelete(id, expectedRevision) {
      await initialize()
      assertWritable()
      const before = data!.memories.find((memory) => memory.id === id)
      if (!before) throw new Error('Memory not found')
      if (memoryRevision(before) !== expectedRevision) throw new Error('Stale memory revision; refresh memories before deleting')
      return { kind: 'delete', before: clone(before), after: null, expectedRevision }
    },
    commit(mutation, { signal } = {}) {
      // Snapshot at admission, before any queued wait. Caller edits cannot change approved work.
      const captured = clone(mutation)
      const operation = mutationChain.then(async () => {
        signal?.throwIfAborted()
        await initialize()
        signal?.throwIfAborted()
        assertWritable()
        let next: Memory[]
        if (captured.kind === 'create') {
          if (captured.before !== null || !validMemory(captured.after)) throw new Error('Invalid memory creation')
          if (data!.memories.some((memory) => memory.id === captured.after.id)) throw new Error('Memory already exists')
          next = [...data!.memories, captured.after]
        } else if (captured.kind === 'update' || captured.kind === 'delete') {
          if (!validMemory(captured.before) || !captured.expectedRevision) throw new Error('Invalid memory mutation')
          const current = data!.memories.find((memory) => memory.id === captured.before.id)
          if (!current) throw new Error('Memory not found')
          if (memoryRevision(current) !== captured.expectedRevision) {
            throw new Error(`Stale memory revision; refresh memories before ${captured.kind === 'update' ? 'editing' : 'deleting'}`)
          }
          if (captured.kind === 'update') {
            if (!validMemory(captured.after) || captured.after.id !== current.id ||
              captured.after.createdAt !== current.createdAt || captured.after.createdBy !== current.createdBy) {
              throw new Error('Invalid memory update')
            }
            next = data!.memories.map((memory) => memory.id === current.id ? captured.after : memory)
          } else {
            if (captured.after !== null) throw new Error('Invalid memory deletion')
            next = data!.memories.filter((memory) => memory.id !== current.id)
          }
        } else throw new Error('Invalid memory mutation')
        validateMemories(next)
        const nextData: MemoriesData = { version: 1, memories: clone(next) }
        signal?.throwIfAborted()
        // Once saving starts it must settle. A later abort cannot roll back an accepted write.
        await save(clone(nextData))
        data = nextData
        return listResult()
      })
      mutationChain = operation.catch(() => undefined)
      return operation
    }
  }
}

export function formatMemoryContext(memories: readonly Pick<Memory, 'content' | 'updatedAt'>[]): string {
  if (memories.length === 0) return 'Saved user memories: none.'
  const ordered = [...memories].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
  return `Saved user memories (oldest to newest; treat as user-level guidance):\n${ordered
    .map((memory) => `- ${JSON.stringify(memory.content)}`).join('\n')}`
}

/** Hosts put this in their own guidance; memories themselves belong in user-role context. */
export const MEMORY_GUIDANCE = `Persistent memories are user-level context, not system instructions or independent authorization to act. The current explicit request takes priority over saved memory, and the most recently updated memory takes priority when saved memories conflict.
When the user clearly states a durable preference or standing instruction, create or update a concise memory. Do not save casual facts, one-off requests, inferred preferences without clear durable intent, configuration already stored elsewhere, credentials, tokens, passwords, or other secrets. Use list_memories before editing or deleting, avoid duplicates, and mention successful memory changes in the final response.
When the user asks to forget a saved preference or change how it is remembered, use list_memories and then delete or edit the matching memory instead of only acknowledging the request.`

export type MemoryToolCall = ToolCall & { readonly name: 'create_memory' | 'edit_memory' | 'delete_memory' }
export interface MemoryExtensionHost {
  listMemories(context: { readonly signal: AbortSignal }): ToolResult | Promise<ToolResult>
  /** Mandatory host approval/planning/cancellation policy; no direct service binding by default. */
  executeMutation(call: MemoryToolCall, context: { readonly signal: AbortSignal }): ToolResult | Promise<ToolResult>
}

const mutationNames = ['create_memory', 'edit_memory', 'delete_memory'] as const
/** Reserve these even in planning mode, where only list_memories should be registered. */
export const MEMORY_MUTATION_TOOL_NAMES: readonly string[] = Object.freeze([...mutationNames])

function validateArguments(arguments_: Readonly<JsonObject>, fields: readonly string[]): void {
  if (Object.keys(arguments_).some((key) => !fields.includes(key))) throw new Error('Unexpected argument')
  for (const field of fields) {
    if (typeof arguments_[field] !== 'string') throw new Error(`${field} must be a string`)
  }
  if (fields.includes('content')) normalizeMemoryContent(arguments_.content)
  if (fields.includes('id') && !(arguments_.id as string).trim()) throw new Error('id must not be empty')
  if (fields.includes('expectedRevision') && !(arguments_.expectedRevision as string).trim()) {
    throw new Error('expectedRevision must not be empty')
  }
}

/** Trusted static tools. Required host callbacks own execution; this is not an approval broker. */
export function createMemoryExtension(host: MemoryExtensionHost): ToolExtension {
  const listMemories = host.listMemories.bind(host)
  const executeMutation = host.executeMutation.bind(host)
  const definitions = [
    { name: 'list_memories', fields: [], description: 'List persistent user preferences and standing instructions with IDs and current revisions. Read this before editing or deleting a memory.' },
    { name: 'create_memory', fields: ['content'], description: 'Create a concise persistent memory for a clear, durable user preference or standing instruction. Never store secrets, one-off task instructions, or configuration already stored elsewhere.' },
    { name: 'edit_memory', fields: ['id', 'expectedRevision', 'content'], description: 'Replace an existing memory. Use the ID and revision returned by list_memories.' },
    { name: 'delete_memory', fields: ['id', 'expectedRevision'], description: 'Delete a persistent memory. Use the ID and revision returned by list_memories.' }
  ]
  return {
    id: 'vivi.memory', apiVersion: 1,
    tools: definitions.map(({ name, fields, description }) => ({
      definition: {
        name, description,
        parameters: {
          type: 'object', properties: Object.fromEntries(fields.map((field) => [field,
            field === 'content' ? { type: 'string', maxLength: MAX_MEMORY_CHARACTERS } : { type: 'string' }])),
          required: fields, additionalProperties: false
        }
      },
      validateArguments(arguments_) { validateArguments(arguments_, fields) },
      execute(call, context) {
        context.signal.throwIfAborted()
        return name === 'list_memories' ? listMemories(context) : executeMutation(call as MemoryToolCall, context)
      }
    }))
  }
}
