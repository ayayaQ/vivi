// SPDX-License-Identifier: Apache-2.0
// Read-only proof against exact host commits. No UI, live keys, or network requests.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { normalizeModelCapabilities, reasoningSelectionSupport } from '../dist/providers/models.js'

const [cliRoot, desktopRoot] = process.argv.slice(2)
if (!cliRoot || !desktopRoot) {
  throw new Error('Usage: node test/prove-capability-hosts.mjs /path/to/vivi-cli /path/to/bot-commander-desktop')
}
const CLI_SHA = 'ad31098bd6947411b659f57c0bb85cb129dfb894'
const DESKTOP_SHA = '929fe4cdb8ea99cc20616761eddfa6c4d2e73944'
const fixture = JSON.parse(await readFile(new URL('./fixtures/capability-host-pairs.json', import.meta.url), 'utf8'))
const temporary = await mkdtemp(join(tmpdir(), 'vivi-capability-host-proof-'))
const originalFetch = globalThis.fetch
const modelFixture = Symbol.for('vivi.capability.local-model-fixture')

function source(root, sha, path) {
  return execFileSync('git', ['-C', root, 'show', `${sha}:${path}`], { encoding: 'utf8' })
}

async function transpile(filename, input) {
  const result = ts.transpileModule(input, {
    fileName: filename.replace(/\.mjs$/, '.ts'),
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
  })
  const path = join(temporary, filename)
  await writeFile(path, result.outputText)
  return pathToFileURL(path).href
}

function cliProjection(module, item) {
  let entry
  try {
    [entry] = module.parseModelCatalog(item.provider, { data: [item.model] })
  } catch (error) {
    if (/No selectable models/.test(error.message)) return { selected: false }
    throw error
  }
  return { selected: true, chat: entry.conversation, tools: entry.tools,
    stream: entry.streaming, reasoning: entry.reasoning, efforts: entry.efforts,
    mandatory: entry.reasoningMandatory }
}

try {
  await writeFile(join(temporary, 'package.json'), '{"private":true,"type":"module"}')
  await mkdir(join(temporary, 'node_modules/openai'), { recursive: true })
  await writeFile(join(temporary, 'node_modules/openai/package.json'),
    '{"name":"openai","private":true,"type":"module","exports":"./index.js"}')
  await writeFile(join(temporary, 'node_modules/openai/index.js'), `
export default class OpenAI {
  constructor() {
    this.models = { list: async () => ({ data: globalThis[Symbol.for('vivi.capability.local-model-fixture')] }) }
  }
}
`)
  await mkdir(join(temporary, 'node_modules/@ayayaq/vivi'), { recursive: true })
  await writeFile(join(temporary, 'node_modules/@ayayaq/vivi/package.json'),
    JSON.stringify({ name: '@ayayaq/vivi', private: true, type: 'module', exports: {
      './providers/openai': './openai.js', './providers/openrouter': './openrouter.js'
    } }))
  for (const [name, factory] of [['openai', 'createOpenAIProvider'], ['openrouter', 'createOpenRouterProvider']]) {
    await writeFile(join(temporary, `node_modules/@ayayaq/vivi/${name}.js`),
      `export function ${factory}(options) { return { provider: '${name}', options } }`)
  }

  const cli = await import(await transpile('cli-models.mjs', source(cliRoot, CLI_SHA, 'src/models.ts')))
  const desktopUrl = await transpile('aiProviderService.mjs',
    source(desktopRoot, DESKTOP_SHA, 'src/main/services/aiProviderService.ts'))
  const desktop = await import(desktopUrl)
  const desktopAgentSource = source(desktopRoot, DESKTOP_SHA, 'src/main/services/agentProviderAdapter.ts')
    .replaceAll("from './aiProviderService'", "from './aiProviderService.mjs'")
  const desktopAgent = await import(await transpile('agentProviderAdapter.mjs', desktopAgentSource))

  for (const item of fixture.cases) {
    const fromCli = cliProjection(cli, item)
    assert.deepEqual(fromCli, item.before.cli, `CLI historical evidence: ${item.name}`)
    globalThis[modelFixture] = [item.model]
    globalThis.fetch = async (url) => {
      assert.equal(String(url), 'https://openrouter.ai/api/v1/models?output_modalities=text')
      return new Response(JSON.stringify({ data: [item.model] }), { headers: { 'Content-Type': 'application/json' } })
    }
    const [entry] = await desktop.fetchAiModels(item.provider, 'local-fixture-key')
    const fromDesktop = entry ? { selected: true, reasoning: entry.supportsReasoning } : { selected: false }
    assert.deepEqual(fromDesktop, item.before.desktopChat, `Desktop historical evidence: ${item.name}`)
    for (const [key, protocol] of [['sharedResponses', 'responses'], ['sharedChat', 'chat-completions']]) {
      if (!item[key]) continue
      const normalized = normalizeModelCapabilities({ apiVersion: 1, provider: item.provider, protocol, model: item.model })
      const { chat, tools, stream, reasoning } = normalized
      assert.deepEqual({ chat, tools, stream, reasoning }, item[key], `Shared seam: ${item.name}`)
    }
  }

  // Extract this small pure function from CLI main, without importing its terminal/UI module.
  const cliMain = source(cliRoot, CLI_SHA, 'src/main.ts')
  const policy = cliMain.match(/export function reasoningPolicy\(level\?: string\): ReasoningSelection \{[\s\S]*?\n\}/)?.[0]
  const efforts = cliMain.match(/^const efforts = .* as const$/m)?.[0]
  assert(policy && efforts, 'Expected exact CLI reasoning policy and effort contract')
  const cliPolicy = await import(await transpile('cli-reasoning-policy.mjs', `${efforts}\n${policy}`))
  assert.deepEqual(cliPolicy.reasoningPolicy('default'), { mode: 'default' })
  assert.deepEqual(cliPolicy.reasoningPolicy('none'), { mode: 'disabled' })
  for (const provider of ['openai', 'openrouter']) {
    const legacy = desktopAgent.createAgentProvider({ aiProvider: provider,
      openaiApiKey: 'local-fixture-key', openrouterApiKey: 'local-fixture-key' },
    { model: 'fixture-model', reasoningEffort: 'none' })
    assert.deepEqual(legacy.options.reasoning, { mode: 'default' })
    assert.deepEqual(legacy.options.supportedReasoningEfforts, ['minimal', 'low', 'medium', 'high', 'xhigh'])
  }
  const mandatory = normalizeModelCapabilities({ apiVersion: 1, provider: 'openai', protocol: 'responses', model: { id: 'gpt-5-pro' } })
  assert.equal(reasoningSelectionSupport(mandatory, cliPolicy.reasoningPolicy('none')), 'unsupported')
  assert.equal(reasoningSelectionSupport(mandatory, { mode: 'default' }), 'supported')
  console.log(`Verified ${fixture.cases.length} historical CLI/desktop pairs and default/none semantics`)
  console.log(`CLI ${CLI_SHA}; desktop ${DESKTOP_SHA}; shared seam local/unpublished`)
  console.log('No network, UI, host mutation, provider request, or live credential was used')
} finally {
  globalThis.fetch = originalFetch
  delete globalThis[modelFixture]
  await rm(temporary, { recursive: true, force: true })
}
