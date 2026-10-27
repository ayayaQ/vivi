// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runAgent, validateHistory, closeInterruptedHistory, estimateContext, compactContext, TOOL_IMAGE_LIMITS } from '../dist/index.js'
const user = content => ({ kind: 'message', role: 'user', content })
const image = { id: 'snapshot:one', sha256: 'a'.repeat(64), mimeType: 'image/png', width: 512, height: 512, byteLength: 100 }
const call = { id: 'one', name: 'read_image', arguments: { path: 'image.png' } }
const assistant = { kind: 'assistant', content: '', toolCalls: [call] }
const result = { kind: 'tool_result', callId: 'one', name: 'read_image', content: 'image observation', images: [image] }
const options = extra => ({ messages: [user('Inspect image.png')], tools: [{ name: 'read_image', description: 'Offline', parameters: {} }],
  provider: { async generate() { return { content: '', toolCalls: [call] } } },
  async executeTool() { return { content: result.content, images: [image] } }, ...extra })

test('image tool result survives canonical acceptance, events, next dispatch and history recovery', async () => {
  const requests = [], updates = [], events = []
  const offered = structuredClone(image)
  const run = await runAgent(options({
    async executeTool() { return { content: result.content, images: [offered] } },
    provider: { async generate(input) { requests.push(input); return requests.length === 1
      ? { content: '', toolCalls: [call] } : { content: 'observed', toolCalls: [] } } },
    onAccepted(update) { updates.push(update); if (update.type === 'tool_result_accepted') {
      assert(Object.isFrozen(update.message.images[0])); offered.id = 'changed after acceptance'
    } },
    onEvent(event) { events.push(event) }
  }))
  assert.equal(run.status, 'completed')
  assert.deepEqual(requests[1].messages[2].images, [image])
  assert.deepEqual(run.history[2].images, [image])
  assert.deepEqual(updates.find(update => update.type === 'tool_result_accepted').message.images, [image])
  assert.deepEqual(events.find(event => event.type === 'tool_completed').message.images, [image])
  validateHistory(run.history)
  const recovered = closeInterruptedHistory([...run.history, { ...assistant, toolCalls: [{ ...call, id: 'two' }] }])
  assert.deepEqual(recovered[2].images, [image])
  assert.equal(recovered.at(-1).isError, true)
})

test('history and tool execution reject malformed or unbounded image references', async () => {
  const invalid = [[], Array(5).fill(image), [image, image], [{ ...image, id: '' }], [{ ...image, sha256: 'A'.repeat(64) }],
    [{ ...image, mimeType: 'image/gif' }], [{ ...image, width: 0 }], [{ ...image, height: 0.5 }],
    [{ ...image, width: 4001, height: 4000 }], [{ ...image, byteLength: 0 }],
    [{ ...image, byteLength: TOOL_IMAGE_LIMITS.bytes + 1 }], [{ ...image, path: '/not/metadata' }]]
  for (const images of invalid) {
    assert.throws(() => validateHistory([assistant, { ...result, images }]))
    const run = await runAgent(options({ maxRounds: 1, async executeTool() { return { content: 'bad', images } } }))
    assert.equal(run.history[2].isError, true)
    assert.equal(run.history[2].images, undefined)
    assert.equal(JSON.parse(run.history[2].content).error.code, 'tool_error')
  }
})

test('image metadata accessors never execute during validation', () => {
  let invoked = false
  const bad = { ...image }
  Object.defineProperty(bad, 'width', { enumerable: true, get() { invoked = true; return 512 } })
  assert.throws(() => validateHistory([assistant, { ...result, images: [bad] }]))
  assert.equal(invoked, false)
})

test('fallback occupancy includes bounded visual allowance without image bytes', () => {
  const text = estimateContext({ messages: [assistant, { ...result, images: undefined }].map(item => {
    const { images, ...without } = item; return without
  }), tools: [] })
  const visual = estimateContext({ messages: [assistant, result], tools: [] })
  assert.equal(visual.estimated, true)
  assert(visual.inputTokens >= text.inputTokens + 8192)
})

test('compaction retains whole recent image/tool batch and summarizes older metadata without claiming pixels', async () => {
  const old = Array.from({ length: 8 }, (_, index) => [user(`old ${index} ${'x'.repeat(500)}`),
    { kind: 'assistant', content: 'y'.repeat(500), toolCalls: [] }]).flat()
  const history = [...old, user('current image'), assistant, result]
  const summaryInputs = []
  const prepared = await compactContext({ messages: history, tools: [], context: { sourceId: 'image-compact', keepRecentMessages: 1 },
    provider: { estimateContext, async generate(input) { summaryInputs.push(input); return { content: 'old conversation', toolCalls: [] } } } })
  assert.deepEqual(prepared.messages.at(-1), result)
  assert.deepEqual(prepared.messages.at(-2), assistant)
  assert.equal(prepared.checkpoint.source.messageCount, old.length + 1)
  assert(prepared.messages.some(item => item.content === 'current image'))
  assert.equal(JSON.stringify(summaryInputs).includes('snapshot:one'), false)
  assert.deepEqual(history.at(-1).images, [image])
})

test('older image summary source preserves snapshot metadata and explicitly forbids invented visual facts', async () => {
  let summaryInput
  const history = [user('older image'), assistant, result, ...Array.from({ length: 8 }, (_, index) =>
    [user(`later ${index} ${'x'.repeat(500)}`), { kind: 'assistant', content: 'y'.repeat(500), toolCalls: [] }]).flat(), user('current')]
  const prepared = await compactContext({ messages: history, tools: [], context: { sourceId: 'old-image', keepRecentMessages: 2 },
    provider: { estimateContext, async generate(input) { summaryInput = input; return { content: 'older conversation (opaque identities omitted by model)', toolCalls: [] } } } })
  assert(prepared.checkpoint)
  assert.match(prepared.checkpoint.summary, /snapshot:one/)
  assert(prepared.checkpoint.summary.includes(image.sha256))
  assert.match(summaryInput.messages[0].content, /never invent visual details/)
  const data = JSON.parse(summaryInput.messages[1].content)
  assert.deepEqual(data.conversation.find(item => item.kind === 'tool_result').images, [image])
  assert.deepEqual(history[2].images, [image])
  const continued = [...history, ...Array.from({ length: 4 }, (_, index) =>
    [{ kind: 'assistant', content: 'z'.repeat(500), toolCalls: [] }, user(`new ${index} ${'w'.repeat(500)}`)]).flat()]
  const again = await compactContext({ messages: continued, tools: [],
    context: { sourceId: 'old-image', keepRecentMessages: 2, checkpoint: prepared.checkpoint },
    provider: { estimateContext, async generate() { return { content: 'model again omitted all identities', toolCalls: [] } } } })
  assert(again.checkpoint.source.messageCount > prepared.checkpoint.source.messageCount)
  assert.match(again.checkpoint.summary, /snapshot:one/)
  assert(again.checkpoint.summary.includes(image.sha256))
})
