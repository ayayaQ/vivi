// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { runAgent } from '../dist/index.js'
import { createAgentProjection, createRunSettlement } from '../dist/events.js'
import { createAgentRunProjection, createAgentRunStart, createAgentAcceptedRecord,
  createAgentRunTerminal, applyAgentRunRecord, projectAgentRunRecords,
  assertAgentRunCurrent } from '../dist/events/stream.js'

const source = { reference: 'host/offline-example', revision: '1' }
const base = createAgentProjection('example-session')
let committed = createAgentRunProjection(base, 'example-run')
const journal = []
const input = [{ id: 'original-user-id', source,
  message: { kind: 'message', role: 'user', content: 'Say hello' } }]
const header = () => ({ version: 1, scope: 'run', sessionId: base.sessionId,
  runId: committed.runId, eventId: `run-record-${committed.sequence + 1}`,
  sequence: committed.sequence + 1, previousEventId: committed.eventId, source })

// Test-only in-memory oracle. A real host owns screened IO, exact commit/readback,
// serialized/CAS admission, current-session checks and draining admitted writes.
async function append(record) {
  assertAgentRunCurrent(committed, base)
  const candidate = applyAgentRunRecord(committed, record)
  journal.push(record)
  committed = candidate
}
await append(createAgentRunStart(header(), base, input))
const result = await runAgent({
  messages: input.map(item => item.message), tools: [],
  provider: { async generate() { return { content: 'Hello', toolCalls: [],
    usage: { inputTokens: 3, outputTokens: 1, totalTokens: 5 } } } },
  executeTool() { throw new Error('No tools advertised') },
  async onAccepted(update) {
    await append(createAgentAcceptedRecord({ envelope: header(), update,
      historyId: `accepted-message-${committed.sequence}`, source }))
  }
})
const terminal = createRunSettlement({ envelope: { version: 1, sessionId: base.sessionId,
  eventId: 'session-terminal-1', sequence: 1, previousEventId: null, source },
  runId: committed.runId, inputHistoryLength: input.length, result,
  history: committed.history, outcomes: [], sessionUsage: result.usage })
await append(createAgentRunTerminal(header(), terminal))
const replayed = projectAgentRunRecords(base, 'example-run', journal)
assert.deepEqual(replayed, committed)
assert.equal(replayed.state, 'settled')
assert.equal(replayed.history[0].id, 'original-user-id')
assert.equal(replayed.runUsage.totalTokens, 5)
console.log('Offline ordered replay:', replayed.state, replayed.history.at(-1).message.content)
