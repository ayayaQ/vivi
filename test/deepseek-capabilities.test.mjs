// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { normalizeModelCapabilities, reasoningSelectionSupport } from '../dist/providers/models.js'

const normalize = (model, protocol = 'chat-completions') =>
  normalizeModelCapabilities({ apiVersion: 1, provider: 'deepseek', protocol, model })
const unknownReasoning = {
  support: 'unknown', disable: 'unknown', effortSelection: 'unknown', efforts: [], requirement: 'unknown'
}
const facts = ({ chat, tools, stream, reasoning }) => ({ chat, tools, stream, reasoning })
const unknownFacts = { chat: 'unknown', tools: 'unknown', stream: 'unknown', reasoning: unknownReasoning }
const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const catalogURL = 'https://api-docs.deepseek.com/api/list-models/'
// Official /models response example reviewed 2026-10-18. The host supplies the
// entry; normalization never fetches a catalog or presumes account access.
const catalog = (id = 'deepseek-flash') => ({
  id, object: 'model', owned_by: 'deepseek',
  name: id === 'deepseek-flash' ? 'DeepSeek-V4.1-Flash' : 'DeepSeek-V4-Pro',
  context_window: 1_048_576, max_output_tokens: 393_216,
  input_modalities: id === 'deepseek-flash' ? ['text', 'image'] : ['text'], output_modalities: ['text'],
  effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' }
})

test('DeepSeek exact reviewed IDs have Chat Completions facts without inventing account access or limits', () => {
  for (const id of ['deepseek-flash', 'deepseek-v4-pro']) {
    const entry = normalize({ id })
    assert.equal(entry.id, id)
    assert.equal(entry.provider, 'deepseek')
    assert.equal(entry.protocol, 'chat-completions')
    assert.deepEqual(facts(entry), {
      chat: 'supported', tools: 'supported', stream: 'supported',
      reasoning: {
        support: 'supported', disable: 'supported', effortSelection: 'supported',
        efforts, requirement: 'optional'
      }
    })
    for (const field of ['available', 'contextWindow', 'maxInputTokens', 'maxOutputTokens', 'contextLimitsSource']) {
      assert.equal(Object.hasOwn(entry, field), false)
    }
    assert.deepEqual(entry.sources.map(({ url }) => url), [
      'https://api-docs.deepseek.com/api/create-chat-completion/',
      'https://api-docs.deepseek.com/guides/thinking_mode/'
    ])
    assert(entry.sources.every(({ kind, reviewedOn }) => kind === 'official-model-documentation' && reviewedOn === '2026-10-18'))
  }
})

test('DeepSeek official catalog limits, text modalities and effort levels normalize without mutation', () => {
  for (const id of ['deepseek-flash', 'deepseek-v4-pro']) {
    const raw = catalog(id)
    const original = structuredClone(raw)
    const entry = normalize(raw)
    assert.deepEqual(raw, original)
    assert.equal(entry.contextWindow, 1_048_576)
    assert.equal(entry.maxOutputTokens, 393_216)
    assert.equal(Object.hasOwn(entry, 'maxInputTokens'), false)
    assert.deepEqual(entry.contextLimitsSource, { kind: 'provider-catalog', url: catalogURL, reviewedOn: '2026-10-18' })
    assert.equal(entry.chat, 'supported')
    assert.equal(entry.tools, 'supported')
    assert.equal(entry.stream, 'supported')
    assert.deepEqual(entry.reasoning.efforts, efforts)
    assert.equal(entry.sources[0].url, catalogURL)
  }
})

test('DeepSeek ID matching is exact and does not reuse provider names, legacy aliases or prefixes', () => {
  for (const id of ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4', 'deepseek-flash-latest',
    'deepseek-flash-2026-10-18', 'DeepSeek-Flash', 'deepseek/deepseek-flash', 'constructor', '__proto__']) {
    const entry = normalize({ id, name: 'DeepSeek-V4.1-Flash', owned_by: 'deepseek' })
    assert.equal(entry.id, id)
    assert.deepEqual(facts(entry), unknownFacts)
    assert.deepEqual(entry.sources, [])
  }
  const input = { apiVersion: 1, protocol: 'chat-completions', model: catalog() }
  for (const provider of ['openai', 'openrouter']) {
    const entry = normalizeModelCapabilities({ ...input, provider })
    assert.deepEqual(facts(entry), unknownFacts)
    assert.equal(Object.hasOwn(entry, 'contextWindow'), false)
  }
})

test('DeepSeek Responses remains unknown even with the complete reviewed catalog entry', () => {
  for (const id of ['deepseek-flash', 'deepseek-v4-pro', 'future-model']) {
    const entry = normalize(catalog(id), 'responses')
    assert.deepEqual(facts(entry), unknownFacts)
    assert.deepEqual(entry.sources, [])
    for (const key of ['contextWindow', 'maxInputTokens', 'maxOutputTokens', 'contextLimitsSource']) {
      assert.equal(Object.hasOwn(entry, key), false)
    }
    assert.equal(reasoningSelectionSupport(entry, { mode: 'effort', effort: 'high' }), 'unknown')
    assert.equal(reasoningSelectionSupport(entry, { mode: 'disabled' }), 'unknown')
  }
})

test('unreviewed DeepSeek IDs gain only supplied catalog evidence', () => {
  const entry = normalize(catalog('future-model'))
  assert.equal(entry.contextWindow, 1_048_576)
  assert.equal(entry.maxOutputTokens, 393_216)
  assert.equal(entry.chat, 'supported')
  assert.equal(entry.tools, 'unknown')
  assert.equal(entry.stream, 'unknown')
  assert.deepEqual(entry.reasoning, {
    support: 'supported', disable: 'unknown', effortSelection: 'supported',
    efforts: ['low', 'high', 'max'], requirement: 'unknown'
  })
  assert.equal(reasoningSelectionSupport(entry, { mode: 'effort', effort: 'minimal' }), 'unsupported')
  assert.equal(reasoningSelectionSupport(entry, { mode: 'disabled' }), 'unknown')
  assert.deepEqual(entry.sources, [{ kind: 'provider-catalog', url: catalogURL, reviewedOn: '2026-10-18' }])
  assert.deepEqual(normalize({ id: 'future-model', supported_parameters: ['tools'], streaming: true,
    api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history' } } }).reasoning, unknownReasoning)
  assert.equal(normalize({ id: 'future-model', supported_parameters: ['tools'], streaming: true }).tools, 'unknown')
})

test('DeepSeek default omission, explicit disable and named effort remain separate', () => {
  const entry = normalize(catalog())
  assert.equal(reasoningSelectionSupport(entry, { mode: 'default' }), 'supported')
  assert.equal(reasoningSelectionSupport(entry, { mode: 'disabled' }), 'supported')
  for (const effort of efforts.filter((value) => value !== 'none')) {
    assert.equal(reasoningSelectionSupport(entry, { mode: 'effort', effort }), 'supported')
  }
  assert.equal(Object.hasOwn(entry.reasoning, 'defaultEffort'), false)
  const missingLevels = normalize({ id: 'future-model', effort: { default_level: 'high' } })
  assert.deepEqual(missingLevels.reasoning, unknownReasoning)
  assert.equal(reasoningSelectionSupport(missingLevels, { mode: 'default' }), 'supported')
  assert.equal(reasoningSelectionSupport(missingLevels, { mode: 'disabled' }), 'unknown')
  assert.throws(() => reasoningSelectionSupport(entry, { mode: 'effort', effort: 'none' }), TypeError)
  assert.throws(() => reasoningSelectionSupport(entry, { mode: 'effort', effort: 'ultra' }), TypeError)
})

test('DeepSeek catalog levels narrow enabled efforts and never infer explicit disable', () => {
  const limited = normalize({ id: 'deepseek-flash', effort: { supported_levels: ['low', 'future'], default_level: 'high' } })
  assert.deepEqual(limited.reasoning.efforts, ['none', 'minimal', 'low'])
  assert.equal(limited.reasoning.requirement, 'optional')
  assert.equal(reasoningSelectionSupport(limited, { mode: 'effort', effort: 'high' }), 'unsupported')
  const highOnly = normalize({ id: 'deepseek-v4-pro', effort: { supported_levels: ['high'] } })
  assert.deepEqual(highOnly.reasoning.efforts, ['none', 'medium', 'high', 'xhigh'])
  for (const supported_levels of [[], ['future'], ['none']]) {
    const entry = normalize({ id: 'future-model', effort: { supported_levels } })
    assert.deepEqual(entry.reasoning.efforts, [])
    assert.equal(entry.reasoning.disable, 'unknown')
    assert.equal(entry.reasoning.requirement, 'unknown')
  }
})

test('DeepSeek modalities prove text conversation separately from tools and streaming', () => {
  for (const raw of [
    { input_modalities: ['image'], output_modalities: ['text'] },
    { input_modalities: ['text'], output_modalities: ['image'] },
    { input_modalities: [], output_modalities: ['text'] },
    { output_modalities: [] }
  ]) {
    const entry = normalize({ id: 'future-model', ...raw })
    assert.equal(entry.chat, 'unsupported')
    assert.equal(entry.tools, 'unknown')
    assert.equal(entry.stream, 'unknown')
  }
  assert.equal(normalize({ id: 'future-model', input_modalities: ['text', 'image'], output_modalities: ['text'] }).chat, 'supported')
  assert.equal(normalize({ id: 'future-model', output_modalities: ['text'] }).chat, 'unknown')
})

test('DeepSeek malformed optional metadata and foreign catalog fields do not create capabilities', () => {
  for (const value of [undefined, null, '', 'text', [1], ['text', null], new Array(1), Array(101).fill('text')]) {
    const entry = normalize({ id: 'future-model', input_modalities: value, output_modalities: value,
      effort: { supported_levels: value, default_level: 'high' } })
    assert.deepEqual(facts(entry), unknownFacts)
  }
  for (const effort of [null, [], 'enabled', {}, { supported_levels: null }, { default_level: 'none' }]) {
    assert.deepEqual(normalize({ id: 'future-model', effort }).reasoning, unknownReasoning)
  }
  const foreign = normalize({ id: 'future-model', context_length: 1234,
    top_provider: { max_completion_tokens: 100 }, max_prompt_tokens: 100,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    reasoning: { mandatory: false, supported_efforts: null }, supported_parameters: ['tools', 'reasoning'] })
  assert.deepEqual(facts(foreign), unknownFacts)
  assert.equal(Object.hasOwn(foreign, 'contextWindow'), false)
})

test('DeepSeek limits accept positive safe integers and reject conflicting output caps', () => {
  for (const value of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '100']) {
    const entry = normalize({ id: 'future-model', context_window: value, max_output_tokens: value })
    assert.equal(Object.hasOwn(entry, 'contextWindow'), false)
    assert.equal(Object.hasOwn(entry, 'maxOutputTokens'), false)
    assert.equal(Object.hasOwn(entry, 'contextLimitsSource'), false)
  }
  const conflict = normalize({ id: 'future-model', context_window: 100, max_output_tokens: 101 })
  assert.equal(conflict.contextWindow, 100)
  assert.equal(Object.hasOwn(conflict, 'maxOutputTokens'), false)
  assert.equal(normalize({ id: 'future-model', max_output_tokens: 123 }).maxOutputTokens, 123)
  assert.equal(normalize({ id: 'future-model', context_window: 123 }).contextWindow, 123)
  assert.equal(normalize({ id: 'future-model', context_window: 123, max_output_tokens: 123 }).maxOutputTokens, 123)
})

test('DeepSeek normalization never invokes optional metadata or array accessors', () => {
  let calls = 0
  const fail = () => { calls++; throw new Error('must not execute') }
  const raw = { id: 'future-model' }
  for (const key of ['context_window', 'max_output_tokens', 'input_modalities', 'output_modalities', 'effort']) {
    Object.defineProperty(raw, key, { get: fail })
  }
  assert.deepEqual(facts(normalize(raw)), unknownFacts)
  const accessor = Object.defineProperty([], '0', { get: fail })
  accessor.length = 1
  assert.deepEqual(facts(normalize({ id: 'future-model', input_modalities: accessor,
    output_modalities: accessor, effort: { supported_levels: accessor } })), unknownFacts)
  const custom = Object.defineProperty(['text'], 'includes', { get: fail })
  assert.equal(normalize({ id: 'future-model', input_modalities: custom, output_modalities: custom }).chat, 'supported')
  const effort = Object.defineProperty({}, 'supported_levels', { get: fail })
  Object.defineProperty(effort, 'default_level', { get: fail })
  assert.deepEqual(normalize({ id: 'future-model', effort }).reasoning, unknownReasoning)
  assert.equal(calls, 0)
})

test('DeepSeek snapshots are detached, deeply frozen and equal in ESM and CommonJS', async () => {
  const raw = catalog()
  const entry = normalize(raw)
  for (const value of [entry, entry.reasoning, entry.reasoning.efforts, entry.sources,
    entry.contextLimitsSource, ...entry.sources]) assert.equal(Object.isFrozen(value), true)
  assert.equal(Object.isFrozen(raw), false)
  assert.equal(Object.isFrozen(raw.effort.supported_levels), false)
  raw.effort.supported_levels.length = 0
  assert.deepEqual(entry.reasoning.efforts, efforts)
  assert.throws(() => entry.reasoning.efforts.push('high'), TypeError)
  const require = createRequire(import.meta.url)
  assert.deepEqual(require('../dist/cjs/providers/models.js').normalizeModelCapabilities({
    apiVersion: 1, provider: 'deepseek', protocol: 'chat-completions', model: catalog()
  }), entry)
  const esm = await readFile(new URL('../dist/providers/models.js', import.meta.url), 'utf8')
  const cjs = await readFile(new URL('../dist/cjs/providers/models.js', import.meta.url), 'utf8')
  assert(!/^import\s/m.test(esm), 'Capability module must stay dependency-free')
  assert(!/require\(/.test(cjs), 'CommonJS capability module must stay dependency-free')
})

test('DeepSeek capability provider is additive in strict ESM and CommonJS declarations', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const temporary = await mkdtemp(join(tmpdir(), 'vivi-deepseek-capability-types-'))
  try {
    await writeFile(join(temporary, 'package.json'), '{"private":true,"type":"module"}')
    const esm = JSON.stringify(join(root, 'dist/providers/models.js'))
    const cjs = JSON.stringify(join(root, 'dist/cjs/providers/models.js'))
    await writeFile(join(temporary, 'consumer.ts'), `
import { normalizeModelCapabilities, type CapabilityInput, type CapabilityProvider } from ${esm}
const provider: CapabilityProvider = 'deepseek'
const input: CapabilityInput = { apiVersion: 1, provider, protocol: 'chat-completions', model: { id: 'deepseek-flash' } }
normalizeModelCapabilities(input)
// @ts-expect-error provider matching remains exact
const invalid: CapabilityProvider = 'DeepSeek'
void invalid
`)
    await writeFile(join(temporary, 'consumer.cts'), `
import capabilities = require(${cjs})
const input: capabilities.CapabilityInput = { apiVersion: 1, provider: 'deepseek', protocol: 'chat-completions', model: { id: 'deepseek-v4-pro' } }
capabilities.normalizeModelCapabilities(input)
`)
    for (const filename of ['consumer.ts', 'consumer.cts']) {
      const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
        '--strict', '--noEmit', '--module', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM', filename],
      { cwd: temporary, encoding: 'utf8' })
      assert.equal(result.status, 0, `${filename}: ${result.stdout}\n${result.stderr}`)
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
