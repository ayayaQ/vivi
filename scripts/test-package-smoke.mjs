// Focused additional-Node compatibility check, not a replacement for test-package.mjs.
// Build once before invoking. Exercise installed public boundaries, not the full suite.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const temporary = await mkdtemp(join(tmpdir(), 'vivi-smoke-'))
const cache = process.env.VIVI_TEST_NPM_CACHE ?? join(tmpdir(), 'vivi-npm-cache')

function run(command, args, cwd = temporary) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false' }
  })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

try {
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary], root))
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, packed.filename)])
  const installed = JSON.parse(await readFile(join(temporary, 'node_modules', source.name, 'package.json'), 'utf8'))
  assert.deepEqual(installed.exports, source.exports)
  const specifiers = Object.keys(source.exports).map(path => path === '.' ? source.name : source.name + path.slice(1))
  for (const extension of ['mjs', 'cjs']) {
    const load = extension === 'mjs' ? 'await import' : 'require'
    const imports = specifiers.map(specifier => `assert(Object.keys(${load}(${JSON.stringify(specifier)})).length > 0)`).join('\n')
    const prelude = extension === 'mjs'
      ? "import assert from 'node:assert/strict'"
      : "const assert = require('node:assert/strict')"
    await writeFile(join(temporary, `consumer.${extension}`), `${prelude}
;(async () => {
${imports}
const { runAgent } = ${load}(${JSON.stringify(source.name)})
const result = await runAgent({
  messages: [], tools: [],
  provider: { async generate() { return { content: 'Compatibility smoke', toolCalls: [] } } },
  async executeTool() { throw new Error('No tools expected') }
})
assert.equal(result.status, 'completed')
})().catch(error => { console.error(error); process.exitCode = 1 })
`)
    run(process.execPath, [`consumer.${extension}`])
  }
  for (const extension of ['mts', 'cts']) {
    const imports = specifiers.map((specifier, index) => extension === 'mts'
      ? `import * as entry${index} from ${JSON.stringify(specifier)}; void entry${index}`
      : `import entry${index} = require(${JSON.stringify(specifier)}); void entry${index}`).join('\n')
    await writeFile(join(temporary, `consumer.${extension}`), imports)
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
      '--strict', '--noEmit', '--module', 'NodeNext', '--target', 'ES2022',
      '--lib', 'ES2022,DOM', `consumer.${extension}`])
  }
  console.log(`Package smoke passed: ${specifiers.length} public ESM/CJS runtime and declaration boundaries`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
