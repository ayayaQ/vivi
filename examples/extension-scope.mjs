// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { runAgent } from '../dist/index.js'
import { createExtensionScope } from '../dist/extensions.js'
import { calculatorExtension } from '../dist/extensions/calculator.js'

const scope = createExtensionScope({ reservedNames: ['host_tool'] })
const cleanup = []
scope.defer(() => { cleanup.push('owned subscription removed') })
scope.register(calculatorExtension)
const registry = scope.snapshot()
try {
  const result = await runAgent({
    provider: { async generate({ messages }) {
      return messages.some(message => message.kind === 'tool_result')
        ? { content: '14', toolCalls: [] }
        : { content: '', toolCalls: [{ id: 'calc-1', name: 'calculate', arguments: { expression: '2*(3+4)' } }] }
    } }, messages: [], tools: registry.tools, executeTool: registry.executeTool, signal: scope.signal
  })
  assert.equal(result.status, 'completed')
  assert.equal(result.content, '14')
} finally {
  await scope.dispose()
}
assert.deepEqual(cleanup, ['owned subscription removed'])
assert.equal(scope.state, 'closed')
await assert.rejects(registry.executeTool({ id: 'late', name: 'calculate', arguments: { expression: '1+1' } },
  { signal: new AbortController().signal }), { name: 'AbortError' })
console.log('Owned extension scope: fixed turn, awaited cleanup, closed dispatch')
