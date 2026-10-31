// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAIProvider } from '../dist/providers/openai.js'
const signal = () => new AbortController().signal
const input = { messages: [{ kind: 'message', role: 'system', content: 'Instructions' }, { kind: 'message', role: 'user', content: 'Hello' }], tools: [] }
const frame = value => `data: ${JSON.stringify(value)}\n\n`
const sse = value => new Response(frame(value), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_fixture_1' } })
const completed = { type: 'response.completed', response: { status: 'completed', output: [] } }

test('trusted request projection is captured once and shared by estimate and generation', async () => {
  const bodies = [], projected = []
  const options = { model: 'fixture', apiKey: 'fixture-key', stream: true,
    transformRequest(body) { body.input[0].role = 'developer'; delete body.max_output_tokens; projected.push(structuredClone(body)); return body },
    fetch: async (_url, init) => { bodies.push(JSON.parse(init.body)); return sse(completed) } }
  const provider = createOpenAIProvider(options)
  options.transformRequest = () => { throw new Error('not captured') }
  const before = structuredClone(input)
  const estimate = provider.estimateContext(input, { maxOutputTokens: 37 })
  await provider.generate(input, signal(), { maxOutputTokens: 37, purpose: 'context-summary' })
  assert.equal(estimate.estimated, true)
  assert.deepEqual(projected[0], bodies[0]); assert.deepEqual(projected[1], bodies[0])
  assert.equal(bodies[0].input[0].role, 'developer'); assert.equal('max_output_tokens' in bodies[0], false)
  assert.deepEqual(input, before)
})

test('request projection cannot alter model/stream identity or return non-JSON data', async () => {
  let requests = 0
  for (const project of [body => ({ ...body, stream: false }), body => ({ ...body, model: 'other' }),
    body => ({ ...body, bad: undefined }), () => null]) {
    const provider = createOpenAIProvider({ model: 'fixture', apiKey: 'fixture-key', stream: true,
      transformRequest: project, fetch: async () => { requests++; throw new Error('unexpected') } })
    assert.throws(() => provider.estimateContext(input), /projection/)
    await assert.rejects(provider.generate(input, signal()), /projection/)
  }
  assert.equal(requests, 0)
})

test('opt-in HTTP and terminal-stream diagnostics preserve safe identifiers but never body text or key', async () => {
  const key = 'fixture-private-key', secret = 'untrusted-private-upstream-message'
  for (const response of [
    new Response(JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', param: 'input[0]', message: secret } }),
      { status: 429, headers: { 'x-request-id': 'req_fixture_1' } }),
    sse({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', param: 'input[0]', message: secret } } })
  ]) {
    const provider = createOpenAIProvider({ model: 'fixture', apiKey: key, stream: true, errorDetails: true, fetch: async () => response })
    await assert.rejects(provider.generate(input, signal()), error => {
      assert.equal(error.details.code, 'subscription_sharing_usage_limit_exceeded')
      assert.equal(error.details.param, 'input[0]'); assert.equal(error.details.requestId, 'req_fixture_1')
      assert.equal(error.details.bodyShape, 'error'); assert(!JSON.stringify(error).includes(secret)); assert(!JSON.stringify(error).includes(key))
      return true
    })
  }
  const provider = createOpenAIProvider({ model: 'fixture', apiKey: key, errorDetails: true,
    fetch: async () => new Response(JSON.stringify({ detail: secret }), { status: 503 }) })
  await assert.rejects(provider.generate(input, signal()), error => error.details.bodyShape === 'detail' && !JSON.stringify(error).includes(secret))
})

test('upstream diagnostics remain opt-in and bearer-shaped identifiers are omitted', async () => {
  for (const errorDetails of [false, true]) {
    const provider = createOpenAIProvider({ model: 'fixture', apiKey: 'fixture-key', errorDetails,
      fetch: async () => new Response(JSON.stringify({ error: { code: 'fixture-key', param: 'bad\nparam' } }), { status: 400 }) })
    await assert.rejects(provider.generate(input, signal()), error => {
      if (errorDetails) assert.deepEqual(error.details, { bodyShape: 'error' })
      else assert.equal(error.details, undefined)
      assert(!JSON.stringify(error).includes('fixture-key')); return true
    })
  }
})
