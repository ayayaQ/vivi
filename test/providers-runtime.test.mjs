// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOpenAIProvider } from '../dist/providers/openai.js'
import { createOpenRouterProvider } from '../dist/providers/openrouter.js'

for (const [name, factory] of [['OpenAI', createOpenAIProvider], ['OpenRouter', createOpenRouterProvider]]) {
  test(`${name} rejects invalid runtime configuration with sanitized errors`, () => {
    const options = { model: 'fixture', apiKey: 'fixture-key', fetch: async () => { throw Error('No network') } }
    for (const config of [undefined, null, true, [], {},
      { ...options, model: '' }, { ...options, model: 'invalid model' },
      { ...options, apiKey: null }, { ...options, apiKey: 'private\r\nsecret' },
      { ...options, apiKey: {} }, { ...options, reasoning: null },
      { ...options, reasoning: 'high' }, { ...options, reasoning: { mode: 'effort', effort: 'none' }, supportedReasoningEfforts: ['none'] },
      { ...options, timeoutMs: null }, { ...options, fetch: null }, { ...options, stream: null },
      { ...options, supportedReasoningEfforts: null }, { ...options, baseURL: null }]) {
      assert.throws(() => factory(config), (error) => {
        assert.equal(error.name, 'ProviderRequestError')
        assert.equal(error.code, 'configuration')
        assert.ok(!error.message.includes('private'))
        assert.ok(!error.message.includes('fixture-key'))
        return true
      })
    }
  })

  test(`${name} permits HTTPS and loopback HTTP only, never embedded credentials or URL secrets`, () => {
    const options = { model: 'fixture', apiKey: 'fixture-key', fetch: async () => { throw Error('No network') } }
    for (const baseURL of ['https://fixture.test/v1', 'http://localhost:1234/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:1234/v1']) {
      assert.ok(factory({ ...options, baseURL }))
    }
    for (const baseURL of ['http://remote.test/v1', 'ftp://localhost/v1', 'https://secret:password@fixture.test', 'https://fixture.test?private-key', 'https://fixture.test/#private-key']) {
      assert.throws(() => factory({ ...options, baseURL }), (error) => {
        assert.equal(error.code, 'configuration')
        assert.ok(!error.message.includes('private-key'))
        assert.ok(!error.message.includes('password'))
        return true
      })
    }
  })
}

test('OpenRouter validates host attribution header values without reflecting them', () => {
  for (const attribution of [null, 1, [], { title: 'private\nvalue' }, { referer: 5 }]) {
    assert.throws(() => createOpenRouterProvider({ model: 'fixture', apiKey: 'fixture-key', attribution }), (error) => {
      assert.equal(error.code, 'configuration')
      assert.ok(!error.message.includes('private'))
      return true
    })
  }
})
