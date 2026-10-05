// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { normalizeModelCapabilities, reasoningSelectionSupport } from '../dist/providers/models.js'

const model = (raw = {}, provider = 'openrouter', protocol = 'chat-completions') =>
  normalizeModelCapabilities({ apiVersion: 1, provider, protocol, model: { id: 'vendor/model:free', ...raw } })
const unknownReasoning = { support: 'unknown', disable: 'unknown', effortSelection: 'unknown', efforts: [], requirement: 'unknown' }
const facts = ({ chat, tools, stream, reasoning }) => ({ chat, tools, stream, reasoning })

test('exact provider/protocol/model identity is preserved without aliases, prefixes or account assumptions', () => {
  for (const id of ['vendor/model:free', '~openai/model-latest', 'constructor', '__proto__',
    'gpt-5-next', 'gpt-5-2099-01-01', 'ft:gpt-5:organization:fixture', 'GPT-5', 'openai/gpt-5']) {
    const entry = model({ id }, 'openai', 'responses')
    assert.equal(entry.id, id)
    assert.deepEqual(facts(entry), { chat: 'unknown', tools: 'unknown', stream: 'unknown', reasoning: unknownReasoning })
  }
  assert.equal(model({ id: 'gpt-5' }, 'openai', 'responses').tools, 'supported')
  assert.equal(model({ id: 'gpt-5' }, 'openrouter').tools, 'unknown')
  assert.equal(model({ id: 'openai/gpt-5', supported_parameters: ['tools'] }, 'openrouter', 'responses').tools, 'unknown')
  // An account-specific listing proves visibility only. It does not add undocumented capabilities.
  const a = model({ id: 'account-specific-model', owned_by: 'account-a', permission: [{ allow_sampling: true }] }, 'openai', 'responses')
  const b = model({ id: 'account-specific-model', owned_by: 'account-b', permission: [] }, 'openai', 'responses')
  assert.deepEqual(a, b)
  assert.equal(Object.hasOwn(a, 'available'), false)
})

test('versions and malformed identities are rejected with stable sanitized errors', () => {
  for (const apiVersion of [undefined, null, 0, 2, '1', NaN]) {
    assert.throws(() => normalizeModelCapabilities({ apiVersion, provider: 'openai', protocol: 'responses', model: { id: 'gpt-5' } }), /API version 1/)
  }
  for (const input of [null, [], {}, new Date()]) assert.throws(() => normalizeModelCapabilities(input), TypeError)
  for (const id of ['', ' gpt-5', 'gpt-5 ', 'a b', '\u0000bad', 'bad\u001b', 'bad\u202e', 'x'.repeat(201), 7, null]) {
    assert.throws(() => model({ id }), /valid exact ID/)
  }
  assert.throws(() => normalizeModelCapabilities({ apiVersion: 1, provider: 'future', protocol: 'responses', model: { id: 'x' } }), /provider/)
  assert.throws(() => model({}, 'openai', 'future'), /protocol/)
  let calls = 0
  const getter = Object.defineProperty({}, 'id', { get() { calls++; throw new Error('fake-sensitive-value') } })
  assert.throws(() => normalizeModelCapabilities({ apiVersion: 1, provider: 'openai', protocol: 'responses', model: getter }), /valid exact ID/)
  assert.equal(calls, 0)
})

test('malformed metadata and future fields never invent support', () => {
  for (const supported_parameters of [undefined, null, 'tools', [12], ['tools', null], new Array(1), Array(101).fill('tools')]) {
    assert.equal(model({ supported_parameters }).tools, 'unknown')
  }
  const accessor = Object.defineProperty([], '0', { get() { throw new Error('Accessor executed') } })
  accessor.length = 1
  assert.equal(model({ supported_parameters: accessor }).tools, 'unknown')
  let methods = 0
  const customMethods = Object.defineProperty(['nonsense'], 'includes', {
    get() { methods++; return () => true }
  })
  assert.equal(model({ supported_parameters: customMethods }).tools, 'unsupported')
  assert.equal(model({ architecture: { input_modalities: customMethods, output_modalities: customMethods } }).chat, 'unsupported')
  assert.deepEqual(model({ reasoning: { supported_efforts: customMethods } }).reasoning.efforts, [])
  assert.equal(methods, 0)
  for (const reasoning of [null, [], 'enabled', {}, { supported_efforts: 'high' }, { mandatory: 'true' },
    { default_effort: '' }, { default_effort: 'future' }, { future_efforts: ['high'] }]) {
    const result = model({ reasoning, future_tools: true, streaming: true })
    assert.deepEqual(result.reasoning, unknownReasoning)
    assert.equal(result.stream, 'unknown')
  }
  for (const architecture of [null, [], {}, { input_modalities: 'text', output_modalities: [1] }]) {
    assert.equal(model({ architecture }).chat, 'unknown')
  }
  assert.equal(model({ supported_parameters: [] }).tools, 'unsupported')
  assert.equal(model({ supported_parameters: ['tools', 'unknown-future-parameter'] }).tools, 'supported')
  // Metadata from another API must not override OpenAI's documented exact-ID facts.
  assert.equal(model({ id: 'gpt-5', supported_parameters: [], reasoning: { supported_efforts: ['none'] } }, 'openai', 'responses').reasoning.requirement, 'required')
})

test('reasoning support, effort selection, provider-default and explicit disable remain distinct', () => {
  const all = model({ reasoning: { supported_efforts: null } })
  assert.deepEqual(all.reasoning.efforts, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(all.reasoning.requirement, 'optional')
  assert.equal(reasoningSelectionSupport(all, { mode: 'default' }), 'supported')
  assert.equal(reasoningSelectionSupport(all, { mode: 'disabled' }), 'supported')
  const mandatory = model({ reasoning: { supported_efforts: ['none', 'high', 'future'], mandatory: true } })
  assert.deepEqual(mandatory.reasoning.efforts, ['high'])
  assert.equal(mandatory.reasoning.requirement, 'required')
  assert.equal(reasoningSelectionSupport(mandatory, { mode: 'default' }), 'supported')
  assert.equal(reasoningSelectionSupport(mandatory, { mode: 'disabled' }), 'unsupported')
  assert.equal(reasoningSelectionSupport(mandatory, { mode: 'effort', effort: 'high' }), 'supported')
  assert.equal(reasoningSelectionSupport(mandatory, { mode: 'effort', effort: 'low' }), 'unsupported')
  const budgetOnly = model({ reasoning: { supports_max_tokens: true, mandatory: true } })
  assert.equal(budgetOnly.reasoning.support, 'supported')
  assert.equal(budgetOnly.reasoning.effortSelection, 'unsupported')
  assert.equal(reasoningSelectionSupport(budgetOnly, { mode: 'effort', effort: 'high' }), 'unsupported')
  assert.equal(reasoningSelectionSupport(budgetOnly, { mode: 'disabled' }), 'unsupported')
  const optionalBudget = model({ reasoning: { supports_max_tokens: true, mandatory: false } })
  assert.equal(optionalBudget.reasoning.support, 'supported')
  assert.equal(optionalBudget.reasoning.effortSelection, 'unsupported')
  assert.deepEqual(optionalBudget.reasoning.efforts, [])
  assert.equal(reasoningSelectionSupport(optionalBudget, { mode: 'disabled' }), 'supported')
  assert.equal(reasoningSelectionSupport(optionalBudget, { mode: 'effort', effort: 'high' }), 'unsupported')
  const unspecifiedBudget = model({ reasoning: { supports_max_tokens: true } })
  assert.equal(reasoningSelectionSupport(unspecifiedBudget, { mode: 'disabled' }), 'unknown')
  const noKnownEfforts = model({ reasoning: { supported_efforts: ['future'] } })
  assert.equal(noKnownEfforts.reasoning.support, 'supported')
  assert.deepEqual(noKnownEfforts.reasoning.efforts, [])
  assert.equal(noKnownEfforts.reasoning.requirement, 'unknown')
  const unknown = model()
  assert.equal(reasoningSelectionSupport(unknown, { mode: 'default' }), 'supported')
  assert.equal(reasoningSelectionSupport(unknown, { mode: 'disabled' }), 'unknown')
  assert.equal(reasoningSelectionSupport(unknown, { mode: 'effort', effort: 'high' }), 'unknown')
  for (const selection of [null, {}, { mode: 'none' }, { mode: 'effort', effort: 'none' }, { mode: 'effort', effort: 'future' }]) {
    assert.throws(() => reasoningSelectionSupport(all, selection), TypeError)
  }
  assert.throws(() => reasoningSelectionSupport({ ...all, apiVersion: 2 }, { mode: 'default' }), /API version 1/)
})

test('endpoint-specific facts keep Responses-only and non-streaming cases separate', () => {
  for (const id of ['gpt-5-pro', 'gpt-5-pro-2025-10-06', 'o3-pro', 'o3-pro-2025-06-10']) {
    assert.equal(model({ id }, 'openai', 'responses').chat, 'supported')
    assert.equal(model({ id }, 'openai', 'chat-completions').chat, 'unsupported')
  }
  const o3 = model({ id: 'o3-pro' }, 'openai', 'responses')
  assert.equal(o3.stream, 'unsupported')
  assert.equal(o3.reasoning.support, 'supported')
  assert.equal(o3.reasoning.effortSelection, 'unknown')
  const old = model({ id: 'gpt-5' }, 'openai', 'responses')
  const newer = model({ id: 'gpt-5.1' }, 'openai', 'responses')
  assert.equal(reasoningSelectionSupport(old, { mode: 'disabled' }), 'unsupported')
  assert.equal(reasoningSelectionSupport(newer, { mode: 'disabled' }), 'supported')
  const noReasoning = model({ id: 'gpt-4.1' }, 'openai', 'responses')
  assert.equal(noReasoning.reasoning.support, 'unsupported')
  assert.equal(reasoningSelectionSupport(noReasoning, { mode: 'default' }), 'supported')
  assert.equal(reasoningSelectionSupport(noReasoning, { mode: 'effort', effort: 'high' }), 'unsupported')
  assert.equal(model({ id: 'text-embedding-3-small' }, 'openai', 'responses').chat, 'unsupported')
})

test('OpenRouter modalities and parameter completeness are independent and do not filter catalog entries', () => {
  assert.equal(model({ architecture: { input_modalities: ['text', 'image'], output_modalities: ['text', 'image'] } }).chat, 'supported')
  for (const architecture of [
    { input_modalities: ['audio'], output_modalities: ['text'] },
    { input_modalities: ['text'], output_modalities: ['image'] },
    { input_modalities: [], output_modalities: ['text'] },
    { output_modalities: ['embedding'] }
  ]) assert.equal(model({ architecture }).chat, 'unsupported')
  assert.equal(model({ architecture: { output_modalities: ['text'] } }).chat, 'unknown')
  assert.equal(model({ supported_parameters: ['include_reasoning'] }).reasoning.support, 'supported')
  assert.equal(model({ supported_parameters: ['tools'] }).reasoning.support, 'unsupported')
  assert.equal(model({ id: 'openrouter/auto', supported_parameters: ['tools'] }).reasoning.support, 'unknown')
  assert.equal(model({ id: 'openrouter/free', supported_parameters: ['tools'] }).reasoning.support, 'unknown')
  assert.equal(model({ supported_parameters: ['tools'], reasoning: null }).reasoning.support, 'unknown')
})

test('normalization is stateless, immutable and importable without transport or host dependencies', async () => {
  const raw = { id: 'vendor/model', reasoning: { supported_efforts: ['none', 'high'] }, supported_parameters: ['tools'] }
  const original = structuredClone(raw)
  const result = model(raw)
  assert.deepEqual(raw, original)
  assert.equal(Object.isFrozen(raw), false)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.reasoning), true)
  assert.equal(Object.isFrozen(result.reasoning.efforts), true)
  assert.equal(Object.isFrozen(result.sources[0]), true)
  raw.reasoning.supported_efforts.length = 0
  assert.deepEqual(result.reasoning.efforts, ['none', 'high'])
  assert.throws(() => result.reasoning.efforts.push('low'), TypeError)
  const next = model(original)
  assert.notEqual(result, next)
  assert.deepEqual(result, next)
  const require = createRequire(import.meta.url)
  assert.deepEqual(require('../dist/cjs/providers/models.js').normalizeModelCapabilities({ apiVersion: 1, provider: 'openrouter', protocol: 'chat-completions', model: original }), result)
  const esm = await readFile(new URL('../dist/providers/models.js', import.meta.url), 'utf8')
  const cjs = await readFile(new URL('../dist/cjs/providers/models.js', import.meta.url), 'utf8')
  assert(!/^import\s/m.test(esm), 'Optional capability module must not import a runtime dependency')
  assert(!/require\(/.test(cjs), 'CommonJS capability module must not import a runtime dependency')
  for (const item of result.sources) {
    assert(item.url.startsWith('https://openrouter.ai/docs/'))
    assert.equal(item.reviewedOn, '2026-10-05')
  }
})

test('paired host fixtures resolve real divergence using one endpoint-aware contract', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/capability-host-pairs.json', import.meta.url), 'utf8'))
  assert.equal(fixture.apiVersion, 1)
  for (const item of fixture.cases) {
    for (const [key, protocol] of [['sharedResponses', 'responses'], ['sharedChat', 'chat-completions']]) {
      if (!item[key]) continue
      const fromCli = normalizeModelCapabilities({ apiVersion: 1, provider: item.provider, protocol, model: structuredClone(item.model) })
      const fromDesktop = normalizeModelCapabilities({ apiVersion: 1, provider: item.provider, protocol, model: structuredClone(item.model) })
      assert.deepEqual(facts(fromCli), item[key], item.name)
      assert.deepEqual(fromDesktop, fromCli, item.name)
      assert.equal(fromCli.id, item.model.id)
    }
  }
})
