// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createToolRegistry } from '@ayayaq/vivi/extensions'
import {
  createMemoryService, createMemoryExtension, formatMemoryContext
} from '@ayayaq/vivi/extensions/memory'

// Offline host simulation. A real host supplies its own recovery and atomic persistence adapter.
let saved = { version: 1, memories: [] }
const service = createMemoryService({
  load() { return structuredClone(saved) },
  assertWritable() {},
  save(next) { saved = structuredClone(next) }
})

// Approval is a host decision. This fake review denies the request; there is no implicit grant.
async function requestApproval(_proposal, { signal }) { signal.throwIfAborted(); return false }
async function withAcceptedPersistenceOperation(operation) { return operation() }

const registry = createToolRegistry([createMemoryExtension({
  async listMemories({ signal }) {
    signal.throwIfAborted()
    return { content: JSON.stringify(await service.list()) }
  },
  async executeMutation(call, context) {
    const args = call.arguments
    const proposal = call.name === 'create_memory'
      ? await service.prepareCreate(args.content, 'agent')
      : call.name === 'edit_memory'
        ? await service.prepareUpdate(args.id, args.expectedRevision, args.content, 'agent')
        : await service.prepareDelete(args.id, args.expectedRevision)
    if (!await requestApproval(proposal, context)) {
      return { content: JSON.stringify({ success: false, error: 'Host approval denied' }), isError: true }
    }
    context.signal.throwIfAborted()
    // Enter real host lifecycle admission BEFORE calling the service's serialized commit.
    const result = await withAcceptedPersistenceOperation(() => service.commit(proposal, context))
    return { content: JSON.stringify(result) }
  }
})])

const result = await registry.executeTool({
  id: 'memory-example', name: 'create_memory', arguments: { content: 'Prefer concise replies' }
}, { signal: new AbortController().signal })
assert.equal(result.isError, true)
assert.equal(saved.memories.length, 0)
console.log(result.content)
console.log(formatMemoryContext((await service.list()).memories))
