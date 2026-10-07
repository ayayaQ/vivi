// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
// Offline shadow review only: no credentials, paid calls, or tool execution.
import assert from 'node:assert/strict'
import { createDecisionRequest, evaluateDecision, isDecisionCurrent } from '../dist/decisions.js'

const snapshot = {
  sessionId: 'example-session', runId: 'example-run',
  toolCall: { id: 'memory-1', name: 'memory_add', arguments: { text: 'Prefers tea' } },
  userRequest: { id: 'request-1', text: 'Remember that I prefer tea', approvedScope: { operation: 'remember_preference' } },
  policyRevision: 'example-policy-1', resourceRevisions: { memories: 7 }, inputData: null
}
const request = createDecisionRequest(snapshot, {
  provider: 'openai', checks: [{
    name: 'matches_request', instructions: 'Is the proposed memory exactly the preference the user asked to remember?',
    trueDescription: 'The proposed memory matches the explicit request.',
    falseDescription: 'The proposed memory adds or changes a preference outside the request.',
    // Illustrative only. These numbers have not been calibrated for a real host or provider.
    allowAt: 0.95, denyAt: 0.05
  }]
})
const mock = {
  id: 'openai', model: 'gpt-6-luna',
  async evaluate(_request, signal) {
    signal.throwIfAborted()
    return { model: 'gpt-6-luna', answers: [{ name: 'matches_request', type: 'predicate', probability: 0.99 }],
      usage: { inputTokens: 42, outputTokens: 0 } }
  }
}
const review = await evaluateDecision(request, mock)
assert.equal(review.outcome, 'allow')
assert.equal(isDecisionCurrent(review, snapshot), true)
assert.equal(isDecisionCurrent(review, { ...snapshot, resourceRevisions: { memories: 8 } }), false)
// A recommendation alone grants no permission. The host still owns eligibility, currentness,
// hard rules, manual review, cancellation, commit, and privacy-safe audit records.
console.log(`Offline decision recommendation: ${review.outcome} (${review.reasonCode}); no tool executed`)
