// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import assert from 'node:assert/strict'
import { routePreparedAction } from '../../dist/decisions/actions.js'

const kinds = ['read', 'write', 'external', 'unknown']
const scopes = ['workspace', 'outside-workspace', 'external', 'unknown']
const reviews = ['ordinary-read', 'model-review', 'manual', 'blocked']
const effect = id => ({ kind: kinds[Math.floor(id / 16)], scope: scopes[Math.floor(id / 4) % 4],
  review: reviews[id % 4], resourceId: 'resource', affectedData: null })
const snapshot = action => ({ sessionId: 'session', runId: 'run', policyRevision: 'policy',
  toolCall: { id: 'call', name: 'tool', arguments: {} },
  userRequest: { id: 'request', text: 'Read the resource', approvedScope: null },
  resourceRevisions: { resource: 'revision' }, inputData: null,
  ...(action === undefined ? {} : { preparedAction: action }) })

export async function checkCorpus(corpus) {
  const lines = corpus.trimEnd().split('\n')
  assert.equal(lines.length, 10499, 'Oracle corpus must be complete')
  const reasons = new Set()
  const singles = new Set()
  const pairs = new Set()
  let maxLength = 0
  for (const [index, line] of lines.entries()) {
    const columns = line.split('\t')
    assert.equal(columns.length, 4)
    const [complete, encoded, route, reasonCode] = columns
    assert(['missing', '0', '1'].includes(complete))
    const ids = encoded === '' ? [] : encoded.split(',').map(n => {
      assert.match(n, /^(?:0|[1-9][0-9]*)$/)
      const id = Number(n)
      assert(id < 64)
      return id
    })
    assert(ids.length <= 256)
    maxLength = Math.max(maxLength, ids.length)
    if (ids.length === 1) singles.add(`${complete}:${encoded}`)
    if (ids.length === 2) pairs.add(`${complete}:${encoded}`)
    const input = snapshot(complete === 'missing' ? undefined : {
      complete: complete === '1', effects: ids.map(effect),
    })
    const before = JSON.stringify(input)
    const actual = routePreparedAction(input)
    assert.deepEqual(actual, { route, reasonCode }, `Lean/TypeScript mismatch at case ${index}: ${line}`)
    assert(Object.isFrozen(actual))
    assert.equal(JSON.stringify(input), before, 'Routing must not mutate the input')
    reasons.add(reasonCode)
  }
  assert.equal(singles.size, 128)
  assert.equal(pairs.size, 8192)
  assert.equal(maxLength, 256)
  assert.equal(reasons.size, 8, 'Every validated routing branch must be covered')

  // Validation is outside the theorem boundary. Exercise the actual boundary,
  // including JS-only shapes, without pretending these are validated model inputs.
  let invalidCount = 0
  const invalid = (input, label) => {
    assert.deepEqual(routePreparedAction(input), { route: 'manual', reasonCode: 'invalid_snapshot' }, label)
    invalidCount++
  }
  for (const field of ['kind', 'scope', 'review']) {
    for (const value of ['unsupported', '', null, false, 7]) {
      const e = effect(0); e[field] = value
      invalid(snapshot({ complete: true, effects: [e] }), `${field}=${value}`)
    }
  }
  for (const action of [null, {}, { complete: true }, { effects: [] },
    { complete: true, effects: null }, { complete: 'true', effects: [] },
    { complete: true, effects: Array(257).fill(effect(0)) },
    { complete: true, effects: Array(1) }]) invalid(snapshot(action), 'Malformed action')
  const missingRevision = snapshot({ complete: true, effects: [effect(0)] })
  missingRevision.resourceRevisions = {}; invalid(missingRevision, 'Missing resource revision')
  const getter = effect(0)
  Object.defineProperty(getter, 'kind', { enumerable: true, get() { throw new Error('Accessor must never run') } })
  invalid(snapshot({ complete: true, effects: [getter] }), 'Accessor')
  const cyclic = snapshot(); cyclic.inputData = cyclic; invalid(cyclic, 'Cycle')
  const omitted = snapshot(); omitted.preparedAction = undefined; invalid(omitted, 'Explicit undefined differs from omitted')
  for (const field of ['resourceId', 'affectedData', 'kind', 'scope', 'review']) {
    const e = effect(0); delete e[field]; invalid(snapshot({ complete: true, effects: [e] }), `Missing ${field}`)
  }
  console.log(`Lean/actual TypeScript differential: ${lines.length} generated cases; ${invalidCount} invalid-boundary cases passed.`)
}
