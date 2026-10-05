// SPDX-License-Identifier: Apache-2.0
// Unpublished optional module proof. Hosts own discovery and model choice.
import assert from 'node:assert/strict'
import { normalizeModelCapabilities, reasoningSelectionSupport } from '../dist/providers/models.js'

const request = { apiVersion: 1, provider: 'openai', model: { id: 'gpt-5-pro' } }
const agent = normalizeModelCapabilities({ ...request, protocol: 'responses' })
const generalChat = normalizeModelCapabilities({ ...request, protocol: 'chat-completions' })
assert.equal(agent.chat, 'supported')
assert.equal(generalChat.chat, 'unsupported')
assert.equal(reasoningSelectionSupport(agent, { mode: 'default' }), 'supported')
assert.equal(reasoningSelectionSupport(agent, { mode: 'disabled' }), 'unsupported')
console.log('Exact endpoint facts preserved; provider-default reasoning is distinct from disable')
