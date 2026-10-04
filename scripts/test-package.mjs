import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'vivi-consumer-'))
const cache = process.env.npm_config_cache ?? join(tmpdir(), 'vivi-npm-cache')

function run(command, arguments_, cwd = root) {
  const result = spawnSync(command, arguments_, { cwd, encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

try {
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary, '--cache', cache]))
  const paths = new Set(packed.files.map((file) => file.path))
  for (const required of ['LICENSE', 'NOTICE', 'ATTRIBUTION.md', 'README.md', 'src/index.ts', 'src/run-agent.ts', 'src/types.ts', 'tsconfig.json', 'tsconfig.cjs.json', 'scripts/finish-build.mjs', 'dist/index.js', 'dist/index.d.ts', 'dist/cjs/index.js', 'dist/cjs/index.d.ts', 'dist/cjs/package.json']) {
    assert(paths.has(required), `Package is missing ${required}`)
  }
  assert([...paths].every((path) => !path.includes('node_modules') && !path.startsWith('test/')))
  const tarball = join(temporary, packed.filename)
  const bytes = await readFile(tarball)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, tarball], temporary)
  const installed = join(temporary, 'node_modules/@vivi/agent-core')
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.equal(manifest.license, 'Apache-2.0')
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0)
  assert.deepEqual(await readFile(join(installed, 'LICENSE')), await readFile(join(root, 'LICENSE')))
  assert((await readFile(join(installed, 'LICENSE'), 'utf8')).includes('Version 2.0, January 2004'))
  assert((await readFile(join(installed, 'ATTRIBUTION.md'), 'utf8')).includes('943e3f84f67e4415a899da8921db84639843c625'))
  await writeFile(join(temporary, 'consumer.mjs'), `
import assert from 'node:assert/strict'
import { runAgent } from '@vivi/agent-core'
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
const { runAgent } = require('@vivi/agent-core')
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
  await writeFile(join(temporary, 'consumer.ts'), `
import { runAgent, type AgentEvent, type AgentResult, type HistoryMessage, type JsonObject, type ModelProvider, type ToolCall, type ToolDefinition } from '@vivi/agent-core'
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
import core = require('@vivi/agent-core')
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
