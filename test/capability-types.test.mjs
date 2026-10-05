// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('optional capability declarations work in strict ESM/CommonJS NodeNext consumers', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const temporary = await mkdtemp(join(tmpdir(), 'vivi-capability-types-'))
  try {
    await writeFile(join(temporary, 'package.json'), '{"private":true,"type":"module"}')
    const esmPath = JSON.stringify(join(root, 'dist/providers/models.js'))
    const cjsPath = JSON.stringify(join(root, 'dist/cjs/providers/models.js'))
    await writeFile(join(temporary, 'consumer.ts'), `
import { normalizeModelCapabilities, reasoningSelectionSupport, type Capability, type CapabilityInput, type ModelCapabilities, type ReasoningSelection } from ${esmPath}
const input: CapabilityInput = { apiVersion: 1, provider: 'openai', protocol: 'responses', model: { id: 'gpt-5.1' } }
const result: ModelCapabilities = normalizeModelCapabilities(input)
const selection: ReasoningSelection = { mode: 'disabled' }
const supported: Capability = reasoningSelectionSupport(result, selection)
// @ts-expect-error unknown contract versions cannot be used
normalizeModelCapabilities({ ...input, apiVersion: 2 })
// @ts-expect-error protocols must be explicit
normalizeModelCapabilities({ ...input, protocol: 'auto' })
// @ts-expect-error default is not a named effort
reasoningSelectionSupport(result, { mode: 'effort', effort: 'default' })
// @ts-expect-error none uses the explicit disabled mode
reasoningSelectionSupport(result, { mode: 'effort', effort: 'none' })
// @ts-expect-error normalized choices cannot be mutated
result.reasoning.efforts.push('high')
void supported
`)
    await writeFile(join(temporary, 'consumer.cts'), `
import capabilities = require(${cjsPath})
const result: capabilities.ModelCapabilities = capabilities.normalizeModelCapabilities({ apiVersion: 1, provider: 'openrouter', protocol: 'chat-completions', model: { id: 'vendor/model' } })
const support: capabilities.Capability = capabilities.reasoningSelectionSupport(result, { mode: 'default' })
// @ts-expect-error unknown providers cannot be used
capabilities.normalizeModelCapabilities({ apiVersion: 1, provider: 'custom', protocol: 'responses', model: { id: 'x' } })
void support
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
