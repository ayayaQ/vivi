// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createOpenAIProvider, projectOpenAiHistory } from '../dist/providers/openai.js'
import { createOpenRouterProvider, projectOpenRouterHistory } from '../dist/providers/openrouter.js'
import { createDeepSeekProvider, projectDeepSeekHistory } from '../dist/providers/deepseek.js'
import { normalizeModelCapabilities } from '../dist/providers/models.js'

const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const reference = { id: 'snapshot-1', sha256: createHash('sha256').update(pixels).digest('hex'),
  mimeType: 'image/png', width: 1, height: 1, byteLength: pixels.byteLength }
const calls = [{ id: 'read-1', name: 'read_image', arguments: { path: 'image.png' } },
  { id: 'state-1', name: 'read_state', arguments: {} }]
function history(kind, model) {
  const assistant = { kind: 'assistant', content: '', toolCalls: structuredClone(calls) }
  if (kind === 'deepseek') assistant.providerState = { provider: `deepseek:${model}`, items: [{
    role: 'assistant', content: '', reasoning_content: 'inspect requested image', tool_calls: calls.map(call => ({
      id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) }
    }))
  }] }
  return [{ kind: 'message', role: 'user', content: 'Inspect image.png' }, assistant,
    { kind: 'tool_result', callId: 'read-1', name: 'read_image', content: 'Snapshot ready', images: [{ ...reference }] },
    { kind: 'tool_result', callId: 'state-1', name: 'read_state', content: 'Second real result' }]
}
function capabilities(kind, model = kind === 'openai' ? 'gpt-4.1' : kind === 'deepseek' ? 'deepseek-flash' : 'fixture/vision') {
  return normalizeModelCapabilities({ apiVersion: 1, provider: kind, protocol: kind === 'openai' ? 'responses' : 'chat-completions',
    model: kind === 'openrouter' ? { id: model, supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } }
      : kind === 'deepseek' ? { id: model, input_modalities: ['text', 'image'], output_modalities: ['text'] } : { id: model } })
}
const factories = { openai: createOpenAIProvider, openrouter: createOpenRouterProvider, deepseek: createDeepSeekProvider }
function harness(kind, options = {}) {
  const facts = capabilities(kind)
  const requests = []
  let resolutions = 0
  const provider = factories[kind]({ model: facts.id, apiKey: 'offline-key', modelCapabilities: facts,
    resolveImage(ref) { resolutions++; assert.deepEqual(ref, reference); return pixels },
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body))
      return new Response(JSON.stringify(kind === 'openai' ? { status: 'completed', output: [] }
        : { choices: [{ message: { role: 'assistant', content: 'Observed' }, finish_reason: 'stop' }] }))
    }, ...options })
  return { provider, requests, resolutions: () => resolutions, input: { messages: history(kind, facts.id), tools: [] } }
}
for (const kind of Object.keys(factories)) {
  test(`${kind} sends actual pixels with exact canonical tool provenance and metadata-only estimation`, async () => {
    const h = harness(kind)
    const before = structuredClone(h.input)
    const estimate = h.provider.estimateContext(h.input)
    assert.equal(h.resolutions(), 0, 'estimation must not require cached historical pixels before compaction')
    assert.ok(estimate.inputTokens >= 8192)
    await h.provider.generate(h.input, new AbortController().signal)
    assert.equal(h.resolutions(), 1)
    assert.deepEqual(h.input, before)
    const body = h.requests[0]
    const projected = body.input ?? body.messages
    if (kind === 'openai') {
      const result = projected.find(item => item.call_id === 'read-1' && item.type === 'function_call_output')
      assert.deepEqual(result.output, [{ type: 'input_text', text: 'Snapshot ready' },
        { type: 'input_image', image_url: `data:image/png;base64,${pixels.toString('base64')}`, detail: 'auto' }])
      assert.equal(projected.filter(item => item.role === 'user').length, 1)
    } else {
      assert.deepEqual(projected.slice(2, 4).map(item => [item.role, item.tool_call_id]), [['tool', 'read-1'], ['tool', 'state-1']])
      assert.equal(projected[4].role, 'user')
      assert.match(projected[4].content[0].text, /Untrusted tool.*not a new user request, instruction, or approval/)
      assert.match(projected[4].content[1].text, /read-1/)
      assert.equal(projected[4].content[2].image_url.url, `data:image/png;base64,${pixels.toString('base64')}`)
    }
    assert.ok(estimate.inputTokens < JSON.stringify(body).length + 9000, 'allowance is bounded, not inline byte text counting')
  })
  test(`${kind} missing/changed snapshots fail explicitly while estimation can still compact metadata`, async () => {
    for (const resolveImage of [undefined, () => { throw new Error('private-original-path') }, () => Uint8Array.from(pixels, value => value ^ 1), () => Promise.resolve(pixels)]) {
      const h = harness(kind, { resolveImage })
      assert.ok(h.provider.estimateContext(h.input).inputTokens > 0)
      await assert.rejects(h.provider.generate(h.input, new AbortController().signal), error => error.code === 'configuration' && !error.message.includes('private-original-path'))
      assert.equal(h.requests.length, 0)
    }
  })
  test(`${kind} unknown/unsupported vision never silently drops image input`, async () => {
    const facts = capabilities(kind)
    for (const vision of ['unknown', 'unsupported']) {
      const h = harness(kind, { modelCapabilities: { ...facts, vision } })
      assert.throws(() => h.provider.estimateContext(h.input), { code: 'configuration' })
      await assert.rejects(h.provider.generate(h.input, new AbortController().signal), { code: 'configuration' })
      assert.equal(h.requests.length, 0)
    }
  })
  test(`${kind} validates reference metadata against bytes and rejects malformed references`, async () => {
    for (const patch of [{ width: 2 }, { mimeType: 'image/jpeg' }, { byteLength: pixels.length + 1 }, { sha256: '0'.repeat(64) }, { extra: true }, { width: 0 }, { width: 16_000_001 }]) {
      const h = harness(kind, { resolveImage: () => pixels })
      Object.assign(h.input.messages[2].images[0], patch)
      await assert.rejects(h.provider.generate(h.input, new AbortController().signal), { code: 'configuration' })
      assert.equal(h.requests.length, 0)
    }
  })
}

test('provider capability identity is bound exactly and captured, not changed by later host edits', async () => {
  const facts = structuredClone(capabilities('openrouter'))
  const h = harness('openrouter', { modelCapabilities: facts })
  facts.vision = 'unsupported'
  await h.provider.generate(h.input, new AbortController().signal)
  for (const patch of [{ id: 'different' }, { protocol: 'responses' }, { provider: 'deepseek' }, { apiVersion: 2 }]) {
    assert.throws(() => harness('openrouter', { modelCapabilities: { ...capabilities('openrouter'), ...patch } }), { code: 'configuration' })
  }
})

test('vision capability is independent, exact and based on model modalities rather than provider-wide assumptions', () => {
  assert.equal(capabilities('openai').vision, 'supported')
  assert.equal(capabilities('openai', 'unknown-model').vision, 'unknown')
  for (const kind of ['openrouter', 'deepseek']) {
    assert.equal(capabilities(kind).vision, 'supported')
    const model = { id: capabilities(kind).id, ...(kind === 'openrouter' ? { architecture: { input_modalities: ['text'], output_modalities: ['text'] } } : { input_modalities: ['text'], output_modalities: ['text'] }) }
    assert.equal(normalizeModelCapabilities({ apiVersion: 1, provider: kind, protocol: 'chat-completions', model }).vision, 'unsupported')
    assert.equal(normalizeModelCapabilities({ apiVersion: 1, provider: kind, protocol: 'responses', model }).vision, 'unknown')
  }
})

test('exported pure projections also bind model capability identity and preserve legacy text output', () => {
  const plain = [{ kind: 'message', role: 'user', content: 'Only text' }]
  assert.deepEqual(projectOpenAiHistory(plain, 'unknown'), [{ role: 'user', content: 'Only text' }])
  assert.deepEqual(projectOpenRouterHistory(plain, 'unknown'), [{ role: 'user', content: 'Only text' }])
  assert.deepEqual(projectDeepSeekHistory(plain, 'unknown'), [{ role: 'user', content: 'Only text' }])
  assert.throws(() => projectOpenAiHistory(history('openai', 'gpt-4.1'), 'different', { modelCapabilities: capabilities('openai'), resolveImage: () => pixels }), { code: 'configuration' })
})

test('metadata estimates ignore encoded bytes but increase with image dimensions', () => {
  const h = harness('openai')
  const small = h.provider.estimateContext(h.input)
  h.input.messages[2].images[0].byteLength = 5 * 1024 * 1024
  assert.deepEqual(h.provider.estimateContext(h.input), small)
  h.input.messages[2].images[0].width = 4000
  h.input.messages[2].images[0].height = 4000
  assert.ok(h.provider.estimateContext(h.input).inputTokens > small.inputTokens * 20)
  assert.equal(h.resolutions(), 0)
})

for (const kind of Object.keys(factories)) {
  test(`${kind} bounds aggregate wire images without blocking pre-compaction metadata estimates`, async () => {
    const h = harness(kind)
    const batch = structuredClone(h.input.messages)
    h.input.messages = []
    for (let index = 0; index < 9; index++) {
      const group = structuredClone(batch)
      for (const message of group) {
        if (message.kind === 'assistant') {
          for (const call of message.toolCalls) call.id += `-${index}`
          if (message.providerState) for (const call of message.providerState.items[0].tool_calls) call.id += `-${index}`
        }
        if (message.kind === 'tool_result') {
          message.callId += `-${index}`
          if (message.images) message.images = Array.from({ length: 4 }, (_, imageIndex) => ({ ...reference, id: `snapshot-${index}-${imageIndex}` }))
        }
      }
      h.input.messages.push(...group)
    }
    assert.ok(h.provider.estimateContext(h.input).inputTokens > 0)
    await assert.rejects(h.provider.generate(h.input, new AbortController().signal), /32-image or 64MiB/)
    assert.equal(h.resolutions(), 0)
    assert.equal(h.requests.length, 0)
  })
}

test('PNG container corruption is not accepted as matching image bytes even with matching digest', () => {
  const corrupt = Buffer.from(pixels)
  corrupt[45] ^= 1
  const changed = { ...reference, sha256: createHash('sha256').update(corrupt).digest('hex') }
  const input = history('openai', 'gpt-4.1')
  input[2].images = [changed]
  assert.throws(() => projectOpenAiHistory(input, 'gpt-4.1', { resolveImage: () => corrupt }), /format or dimensions/)
})

test('OpenRouter cannot discard images from an incomplete real result batch', () => {
  assert.throws(() => projectOpenRouterHistory(history('openrouter', 'fixture/vision').slice(0, -1), 'fixture/vision', {
    modelCapabilities: capabilities('openrouter'), resolveImage: () => pixels
  }), /complete tool-result batch/)
})

// Original generated one-pixel red JPEG, not a downloaded third-party fixture.
test('JPEG snapshots project pixels and validate actual header dimensions', () => {
  const jpeg = readFileSync(new URL('./fixtures/tool-image-1x1.jpg', import.meta.url))
  const ref = { ...reference, mimeType: 'image/jpeg', byteLength: jpeg.length, sha256: createHash('sha256').update(jpeg).digest('hex') }
  const input = history('openai', 'gpt-4.1')
  input[2].images = [ref]
  const projected = projectOpenAiHistory(input, 'gpt-4.1', { resolveImage: () => jpeg })
  assert.equal(projected[3].output[1].image_url, `data:image/jpeg;base64,${jpeg.toString('base64')}`)
  input[2].images[0] = { ...ref, height: 2 }
  assert.throws(() => projectOpenAiHistory(input, 'gpt-4.1', { resolveImage: () => jpeg }), /format or dimensions/)
})
