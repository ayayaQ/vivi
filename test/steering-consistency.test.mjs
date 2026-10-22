// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { runAgent, validateHistory } from '../dist/index.js'
import { createAgentProjection, createRunSettlement, decodeAgentRecord } from '../dist/events.js'
import {
  createAgentRunProjection, createAgentRunStart, createAgentAcceptedRecord,
  createAgentRunTerminal, applyAgentRunRecord, projectAgentRunRecords
} from '../dist/events/stream.js'

const user = content => ({ kind: 'message', role: 'user', content })
const source = { reference: 'owned/steering-consistency', revision: '1' }
const options = extra => ({ messages: [user('Initial')], tools: [],
  provider: { async generate() { return { content: 'Done', toolCalls: [] } } },
  async executeTool() { throw new Error('No tools') }, ...extra })
const header = state => ({ version: 1, scope: 'run', sessionId: 'session', runId: 'run',
  eventId: `run-${state.sequence + 1}`, sequence: state.sequence + 1,
  previousEventId: state.eventId, source })

test('published initial history still retains application metadata without steering', async () => {
  const messages = [{ ...user('Initial'), metadata: { localId: 'input-1' } }]
  validateHistory(messages)
  let query
  const result = await runAgent(options({ messages, provider: { async generate(input) {
    query = input
    return { content: 'Done', toolCalls: [] }
  } } }))
  assert.equal(result.status, 'completed')
  assert.deepEqual(query.messages, messages)
  assert.deepEqual(result.history[0], messages[0])
  assert.notEqual(result.history[0], messages[0])
})

test('enabling steering requires exact initial message and nested envelope fields', async () => {
  const call = { id: 'old-call', name: 'lookup', arguments: { metadata: 'valid argument data' } }
  const assistant = { kind: 'assistant', content: 'Prior', toolCalls: [call],
    providerState: { provider: 'fixture', items: [{ metadata: 'valid opaque data' }] } }
  const tool = { kind: 'tool_result', callId: call.id, name: call.name, content: 'Old result' }
  const histories = [
    [{ ...user('Initial'), metadata: { localId: 'input-1' } }],
    [{ ...assistant, metadata: 'local assistant metadata' }, tool],
    [{ ...assistant, toolCalls: [{ ...call, localId: 'call-1' }] }, tool],
    [{ ...assistant, providerState: { ...assistant.providerState, localId: 'state-1' } }, tool],
    [assistant, { ...tool, localId: 'result-1' }]
  ]
  for (const messages of histories) {
    let requests = 0, pulls = 0
    validateHistory(messages)
    const result = await runAgent(options({ messages,
      provider: { async generate() { requests++; return { content: 'Done', toolCalls: [] } } },
      getSteeringMessages() { pulls++; return [] } }))
    assert.equal(result.status, 'error')
    assert.equal(result.error.code, 'invalid_input')
    assert.equal(requests, 0)
    assert.equal(pulls, 0)
  }
  const canonical = await runAgent(options({ messages: [assistant, tool, user('Continue')],
    getSteeringMessages() { return [] } }))
  assert.equal(canonical.status, 'completed')
})

test('an unknown steering message field rejects the entire batch before user acceptance', async () => {
  const updates = []
  const result = await runAgent(options({
    getSteeringMessages() { return [user('Valid first'), { ...user('Second'), metadata: { localId: 'queue-2' } }] },
    onAccepted(update) { updates.push(update) }
  }))
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'invalid_input')
  assert.equal(result.rounds, 1)
  assert.deepEqual(result.history, [user('Initial'), { kind: 'assistant', content: 'Done', toolCalls: [] }])
  assert.deepEqual(updates.map(update => update.type), ['assistant_accepted'])
})

test('repeated steering references stay independent and persist through ordered and terminal replay', async () => {
  const initial = user('Initial'), same = user('Same'), queue = [same, same, user('Last')]
  const base = createAgentProjection('session'), waiting = createAgentRunProjection(base, 'run')
  const start = createAgentRunStart(header(waiting), base, [{ id: 'initial', source, message: initial }])
  const records = [start], queries = []
  let state = applyAgentRunRecord(waiting, start), rounds = 0, pulls = 0
  const result = await runAgent(options({ messages: [initial],
    provider: { async generate(input) { queries.push(input); return { content: `Round ${++rounds}`, toolCalls: [] } } },
    getSteeringMessages() { return ++pulls === 1 ? queue : [] },
    onAccepted(update) {
      const record = createAgentAcceptedRecord({ envelope: header(state), update,
        historyId: `accepted-${state.sequence}`, source })
      state = applyAgentRunRecord(state, record)
      records.push(record)
    }
  }))
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.history.slice(2, 5), queue)
  assert.notEqual(result.history[2], result.history[3])
  assert.notEqual(result.history[2], same)
  assert.notEqual(queries[1].messages[2], queries[1].messages[3])
  const terminal = createRunSettlement({
    envelope: { version: 1, sessionId: 'session', eventId: 'settled', sequence: 1, previousEventId: null, source },
    runId: 'run', inputHistoryLength: state.inputHistoryLength, result,
    history: state.history, outcomes: [], sessionUsage: result.usage
  })
  assert.deepEqual(decodeAgentRecord(terminal), terminal)
  const final = createAgentRunTerminal(header(state), terminal)
  assert.deepEqual(projectAgentRunRecords(base, 'run', [...records, final]), applyAgentRunRecord(state, final))
  result.history[2].content = 'Caller edit'
  assert.equal(result.history[3].content, 'Same')
  assert.equal(queries[1].messages[2].content, 'Same')
  assert.equal(terminal.snapshot.history[2].message.content, 'Same')
  assert.equal(same.content, 'Same')
})
