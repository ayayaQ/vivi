// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createExtensionScope } from '../dist/extensions.js'
import { createQuestionExtension } from '../dist/extensions/questions.js'

// Offline synthetic input only. A real host must await actual human interaction.
const scope = createExtensionScope()
scope.register(createQuestionExtension({
  ask(request, { signal }) {
    signal.throwIfAborted()
    return {
      requestId: request.requestId,
      status: 'answered',
      answers: [{ id: 'format', answer: { kind: 'text', text: 'A short checklist' } }]
    }
  }
}))
try {
  const registry = scope.snapshot()
  const result = await registry.executeTool({
    id: 'clarify-format',
    name: 'request_user_input',
    arguments: { questions: [{ id: 'format', header: 'Format', question: 'How should the plan be presented?' }] }
  }, { signal: new AbortController().signal })
  const response = JSON.parse(result.content)
  assert.equal(response.status, 'answered')
  assert.equal(response.answers[0].answer.text, 'A short checklist')
  assert.equal(createQuestionExtension().tools.length, 0)
  console.log('Offline question host returned explicit clarification; no action was authorized')
} finally {
  await scope.dispose()
}
