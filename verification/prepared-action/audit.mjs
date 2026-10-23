// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import assert from 'node:assert/strict'
export const expectedTheorems = ['blocked_precedence', 'manual_precedence', 'auto_read_guards', 'auto_read_effects']
  .map(name => `PreparedAction.${name}`)
export function verifyAudit(audit) {
  const reports = new Map()
  for (const line of audit.trim().split('\n')) {
    const match = /^'([^']+)' (?:depends on axioms: \[([^\]]*)\]|does not depend on any axioms)$/.exec(line.trim())
    assert(match, `Unrecognized axiom audit output: ${line}`)
    assert(!reports.has(match[1]), `Duplicate axiom report: ${match[1]}`)
    reports.set(match[1], (match[2] ?? '').split(',').map(s => s.trim()).filter(Boolean))
  }
  assert.deepEqual([...reports.keys()].sort(), [...expectedTheorems].sort(), 'Missing or extra theorem audits')
  for (const [name, axioms] of reports) {
    assert(axioms.every(a => ['propext', 'Classical.choice', 'Quot.sound'].includes(a)), `${name}: unexpected axioms ${axioms}`)
  }
}
