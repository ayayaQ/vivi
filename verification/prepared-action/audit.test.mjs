// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import test from 'node:test'
import assert from 'node:assert/strict'
import { expectedTheorems, verifyAudit } from './audit.mjs'
const valid = expectedTheorems.map(n => `'${n}' depends on axioms: [propext]`).join('\n')
test('audit accepts only complete recognized reports and explicit trusted axioms', () => {
  assert.doesNotThrow(() => verifyAudit(valid))
  for (const bad of ['', valid.split('\n').slice(1).join('\n'), `${valid}\n${valid}`,
    valid.replace('propext', 'sorryAx'), valid.replace('propext', 'Custom.assumption'),
    valid.replace(expectedTheorems[0], 'Replacement.weakerTheorem'), `${valid}\nunrecognized output`]) {
    assert.throws(() => verifyAudit(bad))
  }
})
