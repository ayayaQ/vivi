// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createToolRegistry } from '../dist/extensions.js'
import { createSkillCatalog, createSkillsExtension, formatSkillCatalogContext,
  parseSkillDocument, skillCreatorSource } from '../dist/extensions/skills.js'

// Offline host example: in-memory storage stands in for an approved app-wide skill store.
const store = new Map()
let approvals = 0
function snapshot() {
  return createSkillCatalog([skillCreatorSource, ...[...store.values()].map(content => ({ content }))])
}
const catalog = snapshot()
const extension = createSkillsExtension({
  catalog,
  authorizeRead() { return true },
  save: {
    authorize(proposal) {
      approvals++
      console.log(`Review synthetic draft for ${proposal.name}: ${proposal.after.revision}`)
      return true // A real host uses its approval UI and the exact content, never this blanket grant.
    },
    commit(proposal, { signal }) {
      signal.throwIfAborted()
      // Real hosts hold their file transaction/lock across this recheck and atomic commit.
      const current = store.get(proposal.name)
      const actual = current === undefined ? null : parseSkillDocument(current).revision
      if (actual !== proposal.expectedRevision) throw Error('Skill changed after review')
      store.set(proposal.name, proposal.after.content)
    }
  }
})
const registry = createToolRegistry([extension])
const context = { signal: new AbortController().signal }
const listed = await registry.executeTool({ id: 'list', name: 'list_skills', arguments: {} }, context)
const creator = JSON.parse(listed.content).skills[0]
const loaded = await registry.executeTool({ id: 'read', name: 'read_skill', arguments: {
  name: creator.name, path: 'SKILL.md', expectedRevision: creator.revision
} }, context)
assert.equal(JSON.parse(loaded.content).content, skillCreatorSource.content)
const draft = '---\nname: concise-summary\ndescription: Summarize a supplied passage into three concise bullets. Use when a three-bullet summary is requested.\n---\n\nRead the supplied passage, identify its three main points, and return three short factual bullets.\n'
const saved = await registry.executeTool({ id: 'save', name: 'save_skill', arguments: {
  name: 'concise-summary', content: draft, expectedRevision: null
} }, context)
assert.equal(JSON.parse(saved.content).saved, true)
assert.equal(approvals, 1)
assert.equal(catalog.skills.length, 1) // This turn's catalog never hot-reloads.
assert.equal(snapshot().skills.length, 2) // The next turn sees the newly saved skill.
assert(!formatSkillCatalogContext(catalog).includes('## Understand the workflow'))
console.log('Offline skills discovery, explicit read and host-reviewed save passed')
