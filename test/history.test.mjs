// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { closeInterruptedHistory, validateHistory } from '../dist/index.js'

const call = (id) => ({ id, name: 'change', arguments: { expectedRevision: 1 } })
const assistant = (...calls) => ({ kind: 'assistant', content: '', toolCalls: calls })
const result = (id) => ({ kind: 'tool_result', callId: id, name: 'change', content: 'done' })
const user = { kind: 'message', role: 'user', content: 'Continue' }

test('recovery closes only interrupted suffixes and never changes completed results', () => {
  const source = [assistant(call('a'), call('b')), result('a'), user, assistant(call('c'))]
  const original = structuredClone(source)
  const recovered = closeInterruptedHistory(source)
  validateHistory(recovered)
  assert.deepEqual(source, original)
  assert.deepEqual(recovered[1], result('a'))
  assert.equal(recovered[2].callId, 'b')
  assert.equal(recovered.at(-1).callId, 'c')
  for (const message of [recovered[2], recovered.at(-1)]) {
    assert.equal(message.isError, true)
    const failure = JSON.parse(message.content)
    assert.equal(failure.error.code, 'interrupted')
    assert.match(failure.error.message, /outcome may be unknown/)
  }
  assert.deepEqual(closeInterruptedHistory(recovered), recovered)
  recovered[0].toolCalls[0].arguments.expectedRevision = 99
  assert.equal(source[0].toolCalls[0].arguments.expectedRevision, 1)
})

test('complete validation rejects partial, duplicate, out-of-order and orphaned histories', () => {
  for (const history of [
    [assistant(call('a'))],
    [assistant(call('a')), result('a'), assistant(call('a')), result('a')],
    [assistant(call('a'), call('b')), result('b'), result('a')],
    [result('a')]
  ]) assert.throws(() => validateHistory(history))
})

test('recovery rejects malformed results instead of fabricating a replayable transcript', () => {
  for (const history of [
    [assistant(call('a'), call('b')), result('b')],
    [assistant(call('a')), user, result('a')],
    [assistant(call('a')), { ...result('a'), name: 'different' }],
    [{ kind: 'assistant', content: '', toolCalls: [{ ...call('a'), arguments: null }] }]
  ]) assert.throws(() => closeInterruptedHistory(history))
})

test('history helpers reject non-JSON data without invoking accessors', () => {
  let invoked = false
  const message = { kind: 'message', role: 'user' }
  Object.defineProperty(message, 'content', { enumerable: true, get() { invoked = true; return 'bad' } })
  assert.throws(() => closeInterruptedHistory([message]))
  assert.throws(() => validateHistory([message]))
  assert.equal(invoked, false)
})
