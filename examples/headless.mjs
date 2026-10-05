// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { runAgent } from '@ayayaq/vivi'
import { createToolRegistry } from '@ayayaq/vivi/extensions'
import { calculatorExtension } from '@ayayaq/vivi/extensions/calculator'

const registry = createToolRegistry([calculatorExtension])
const result = await runAgent({
  provider: { async generate({ messages }) {
    const answer = messages.find(message => message.kind === 'tool_result')
    return answer
      ? { content: answer.content, toolCalls: [] }
      : { content: '', toolCalls: [
        { id: 'calc-1', name: 'calculate', arguments: { expression: '2*(3+4)' } }
      ] }
  } },
  messages: [{ kind: 'message', role: 'user', content: 'Calculate 2*(3+4)' }],
  tools: registry.tools,
  executeTool: registry.executeTool
})
assert.equal(result.status, 'completed')
assert.equal(result.content, '{"result":14}')
assert.equal(result.rounds, 2)
console.log(result.status, result.content)
