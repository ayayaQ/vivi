import { runAgent } from '../dist/index.js'

// Entirely local: the host owns inventory, tool schemas, and permission decisions.
const inventory = new Map([['notebook', { quantity: 12, revision: 3 }]])
const tools = [
  {
    name: 'lookup_inventory',
    description: 'Find stock and current revision for an item',
    parameters: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] }
  },
  {
    name: 'reserve_inventory',
    description: 'Reserve one item with an expected revision, subject to host approval',
    parameters: {
      type: 'object',
      properties: { sku: { type: 'string' }, revision: { type: 'integer' } },
      required: ['sku', 'revision']
    }
  }
]

const provider = {
  async generate({ messages }, signal) {
    signal.throwIfAborted()
    const results = messages.filter((message) => message.kind === 'tool_result')
    if (results.length === 0) {
      return {
        content: 'Checking notebook stock',
        toolCalls: [{ id: 'lookup-1', name: 'lookup_inventory', arguments: { sku: 'notebook' } }]
      }
    }
    if (results.length === 1) {
      const { revision } = JSON.parse(results[0].content)
      return {
        content: 'Requesting a reservation',
        toolCalls: [{ id: 'reserve-1', name: 'reserve_inventory', arguments: { sku: 'notebook', revision } }]
      }
    }
    return {
      content: '12 notebooks are available. The host denied the reservation, so stock is unchanged',
      toolCalls: []
    }
  }
}

const result = await runAgent({
  provider,
  tools,
  messages: [{ kind: 'message', role: 'user', content: 'Check notebooks and reserve one' }],
  async executeTool(call, { signal }) {
    signal.throwIfAborted()
    const item = inventory.get(call.arguments.sku)
    if (!item) return { content: JSON.stringify({ error: 'Unknown SKU' }), isError: true }
    if (call.name === 'lookup_inventory') return { content: JSON.stringify(item) }

    // Approval policy lives here, not inside vivi. A real host would wait with the same signal,
    // then recheck cancellation, approval, and revision immediately before committing a write.
    const approved = false
    if (!approved) return { content: JSON.stringify({ denied: true }), isError: true }
    signal.throwIfAborted()
    if (call.arguments.revision !== item.revision) throw new Error('Inventory revision changed')
    inventory.set(call.arguments.sku, { quantity: item.quantity - 1, revision: item.revision + 1 })
    return { content: JSON.stringify({ reserved: true }) }
  }
})

if (result.status !== 'completed') throw new Error(result.error?.message ?? result.status)
if (inventory.get('notebook').quantity !== 12) throw new Error('Denied tool changed inventory')
console.log(result.content)
