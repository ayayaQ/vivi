// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { runAgent } from '../dist/index.js'
import { createRunSettlement, createAgentProjection, applyAgentRecord, projectAgentRecords } from '../dist/events.js'

const result = await runAgent({
  messages: [{ kind: 'message', role: 'user', content: 'Offline terminal contract' }], tools: [],
  provider: { async generate() { return { content: 'Settled', toolCalls: [], usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } } } },
  async executeTool() { throw Error('No tools expected') }
})
const source = { reference: 'host/offline-checkpoint', revision: '1' }
const record = createRunSettlement({
  envelope: { version: 1, sessionId: 'offline-session', eventId: 'offline-event', sequence: 1, previousEventId: null, source },
  runId: 'offline-run', inputHistoryLength: 1, result,
  history: result.history.map((message, index) => ({ id: `offline-message-${index}`, source, message })),
  outcomes: [], sessionUsage: result.usage
})
// A real host screens and durably checkpoints this record before publishing/acknowledging it.
const incremental = applyAgentRecord(createAgentProjection(record.sessionId), record)
assert.deepEqual(projectAgentRecords(record.sessionId, [record]), incremental)
assert.equal(applyAgentRecord(incremental, record), incremental)
assert.equal(incremental.runs[0].status, 'completed')
console.log('Offline terminal record replay and duplicate projection passed')
