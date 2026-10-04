import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const sourceManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const temporary = await mkdtemp(join(tmpdir(), 'vivi-consumer-'))
const cache = process.env.VIVI_TEST_NPM_CACHE ?? join(tmpdir(), 'vivi-npm-cache')

function run(command, arguments_, cwd = root) {
  const result = spawnSync(command, arguments_, {
    cwd, encoding: 'utf8',
    env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false' }
  })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

try {
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary, '--cache', cache]))
  const paths = new Set(packed.files.map((file) => file.path))
  for (const required of ['LICENSE', 'NOTICE', 'ATTRIBUTION.md', 'README.md', 'RELEASING.md', 'src/index.ts', 'src/run-agent.ts', 'src/types.ts', 'src/history.ts', 'src/providers/openai.ts', 'src/providers/openrouter.ts', 'tsconfig.json', 'tsconfig.cjs.json', 'scripts/clean-build.mjs', 'scripts/finish-build.mjs', 'dist/index.js', 'dist/index.d.ts', 'dist/providers/openai.js', 'dist/providers/openai.d.ts', 'dist/providers/openrouter.js', 'dist/providers/openrouter.d.ts', 'dist/cjs/index.js', 'dist/cjs/index.d.ts', 'dist/cjs/providers/openai.js', 'dist/cjs/providers/openrouter.js', 'dist/cjs/package.json']) {
    assert(paths.has(required), `Package is missing ${required}`)
  }
  assert([...paths].every((path) => !path.includes('node_modules') && !path.startsWith('test/')))
  const tarball = join(temporary, packed.filename)
  const bytes = await readFile(tarball)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, tarball], temporary)
  const installed = join(temporary, 'node_modules/@ayayaq/vivi')
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@ayayaq/vivi')
  assert.equal(manifest.version, sourceManifest.version)
  assert.equal(packed.filename, `ayayaq-vivi-${sourceManifest.version}.tgz`)
  assert.equal(manifest.publishConfig.access, 'public')
  assert.equal(manifest.license, 'Apache-2.0')
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0)
  assert.deepEqual(await readFile(join(installed, 'LICENSE')), await readFile(join(root, 'LICENSE')))
  assert((await readFile(join(installed, 'LICENSE'), 'utf8')).includes('Version 2.0, January 2004'))
  assert((await readFile(join(installed, 'ATTRIBUTION.md'), 'utf8')).includes('943e3f84f67e4415a899da8921db84639843c625'))
  await writeFile(join(temporary, 'consumer.mjs'), `
import assert from 'node:assert/strict'
import { runAgent } from '@ayayaq/vivi'
let calls = 0
const result = await runAgent({
  provider: { async generate({ messages }) {
    return messages.some(message => message.kind === 'tool_result')
      ? { content: 'Stock: 7', toolCalls: [] }
      : { content: '', toolCalls: [{ id: 'inventory-1', name: 'inventory', arguments: { sku: 'pencil' } }] }
  } },
  messages: [{ kind: 'message', role: 'user', content: 'How many pencils?' }],
  tools: [{ name: 'inventory', description: 'Look up stock', parameters: { type: 'object' } }],
  async executeTool(call) { assert.equal(call.arguments.sku, 'pencil'); calls++; return { content: '7' } }
})
assert.equal(result.status, 'completed')
assert.equal(result.content, 'Stock: 7')
assert.equal(calls, 1)
assert.equal(result.rounds, 2)
`)
  run(process.execPath, ['consumer.mjs'], temporary)
  await writeFile(join(temporary, 'consumer.cjs'), `
const assert = require('node:assert/strict')
const { runAgent } = require('@ayayaq/vivi')
;(async () => {
  const result = await runAgent({
    provider: { async generate() { return { content: 'CommonJS works', toolCalls: [] } } },
    messages: [], tools: [], async executeTool() { throw new Error('No tools expected') }
  })
  assert.equal(result.status, 'completed')
  assert.equal(result.content, 'CommonJS works')
})().catch(error => { console.error(error); process.exitCode = 1 })
`)
  run(process.execPath, ['consumer.cjs'], temporary)
  await writeFile(join(temporary, 'providers.mjs'), `
import assert from 'node:assert/strict'
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
import { createOpenRouterProvider } from '@ayayaq/vivi/providers/openrouter'
const openai = createOpenAIProvider({ apiKey: 'fake', model: 'fake', fetch: async () => new Response(JSON.stringify({ status:'completed', output:[{type:'message',id:'msg-1',role:'assistant',content:[{type:'output_text',text:'OpenAI',annotations:[]}]}] })) })
const router = createOpenRouterProvider({ apiKey: 'fake', model: 'fake', fetch: async () => new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'OpenRouter'}}]})) })
assert.equal((await openai.generate({messages:[],tools:[]},new AbortController().signal)).content,'OpenAI')
assert.equal((await router.generate({messages:[],tools:[]},new AbortController().signal)).content,'OpenRouter')
`)
  run(process.execPath, ['providers.mjs'], temporary)
  await writeFile(join(temporary, 'providers.cjs'), `
const assert = require('node:assert/strict')
const { createOpenAIProvider } = require('@ayayaq/vivi/providers/openai')
const { createOpenRouterProvider } = require('@ayayaq/vivi/providers/openrouter')
assert.equal(typeof createOpenAIProvider({apiKey:'fake',model:'fake'}).generate,'function')
assert.equal(typeof createOpenRouterProvider({apiKey:'fake',model:'fake'}).generate,'function')
`)
  run(process.execPath, ['providers.cjs'], temporary)
  await writeFile(join(temporary, 'consumer.ts'), `
import { runAgent, type AgentEvent, type AgentResult, type HistoryMessage, type JsonObject, type ModelProvider, type ToolCall, type ToolDefinition } from '@ayayaq/vivi'
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
import { createOpenRouterProvider } from '@ayayaq/vivi/providers/openrouter'
const openai: ModelProvider = createOpenAIProvider({apiKey:'fake',model:'fake',reasoning:{mode:'default'}})
const router: ModelProvider = createOpenRouterProvider({apiKey:'fake',model:'fake',stream:true})
void openai; void router
const parameters: JsonObject = { type: 'object' }
const tools: ToolDefinition[] = [{ name: 'inventory', description: 'Stock', parameters }]
const messages: HistoryMessage[] = [{ kind: 'message', role: 'user', content: 'Stock?' }]
const provider: ModelProvider = { async generate(input, signal) {
  signal.throwIfAborted()
  return { content: String(input.messages.length), toolCalls: [], providerState: { provider: 'fake', items: [{ type: 'reasoning', content: 'opaque' }] } }
} }
const result: AgentResult = await runAgent({ provider, tools, messages,
  async executeTool(call: ToolCall, { signal }) { signal.throwIfAborted(); return { content: call.name } },
  onEvent(event: AgentEvent) { if (event.type === 'assistant') console.log(event.message.content) }
})
console.log(result.status)
`)
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--noEmit', '--module', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM', 'consumer.ts'], temporary)
  await writeFile(join(temporary, 'consumer.cts'), `
import core = require('@ayayaq/vivi')
import openai = require('@ayayaq/vivi/providers/openai')
import router = require('@ayayaq/vivi/providers/openrouter')
const shared: core.ModelProvider[] = [openai.createOpenAIProvider({apiKey:'fake',model:'fake'}),router.createOpenRouterProvider({apiKey:'fake',model:'fake'})]
void shared
const provider: core.ModelProvider = { async generate() { return { content: 'CommonJS declarations work', toolCalls: [] } } }
const result: Promise<core.AgentResult> = core.runAgent({ provider, messages: [], tools: [], async executeTool() { return { content: '' } } })
void result
`)
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--noEmit', '--module', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM', 'consumer.cts'], temporary)
  console.log(`Packaged ESM/CommonJS runtime and TypeScript consumers passed (${packed.filename})`)
  console.log(`sha256 ${sha256}`)
  console.log(`integrity ${packed.integrity}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
