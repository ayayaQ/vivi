// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('prefix and image contracts typecheck for ESM and CommonJS consumers', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const directory = await mkdtemp(join(tmpdir(), 'vivi-image-prefix-types-'))
  try {
    await writeFile(join(directory, 'package.json'), '{"private":true,"type":"module"}')
    for (const [filename, prefix] of [['consumer.ts', 'dist'], ['consumer.cts', 'dist/cjs']]) {
      const modulePath = JSON.stringify(join(root, prefix, 'index.js'))
      const openaiPath = JSON.stringify(join(root, prefix, 'providers/openai.js'))
      const eventPath = JSON.stringify(join(root, prefix, 'events.js'))
      await writeFile(join(directory, filename), `
import { type RunAgentOptions, type ToolImageReference, type ToolResult, type ToolResultMessage, TOOL_IMAGE_LIMITS } from ${modulePath}
import { createOpenAIProvider } from ${openaiPath}
import { type AgentRecordEnvelope } from ${eventPath}
const prefix: RunAgentOptions['getContextPrefix'] = async ({ signal }) => {
  void signal.aborted
  return [{ kind: 'message', role: 'system', content: 'frame' }, { kind: 'message', role: 'user', content: 'quoted project context' }]
}
const image: ToolImageReference = { id: 'snapshot', sha256: 'a'.repeat(64), mimeType: 'image/png', width: 1, height: 1, byteLength: 10 }
const result: ToolResult = { content: 'image', images: [image] }
const canonical: ToolResultMessage = { kind: 'tool_result', callId: 'one', name: 'read_image', ...result }
const version: AgentRecordEnvelope['version'] = 2
createOpenAIProvider({ apiKey: 'offline', model: 'gpt-4.1', resolveImage(reference) { const valid: ToolImageReference = reference; void valid; return new Uint8Array(10) } })
// @ts-expect-error prefixes cannot supply assistant history
const invalid: RunAgentOptions['getContextPrefix'] = () => [{ kind: 'assistant', content: '', toolCalls: [] }]
// @ts-expect-error only bounded PNG/JPEG snapshot formats are supported
const wrongImage: ToolImageReference = { ...image, mimeType: 'image/gif' }
// @ts-expect-error image array is readonly
canonical.images?.push(image)
void prefix; void canonical; void version; void TOOL_IMAGE_LIMITS; void invalid; void wrongImage
`)
      const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--noEmit',
        '--module', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM', join(directory, filename)],
      { cwd: directory, encoding: 'utf8' })
      assert.equal(result.status, 0, `${filename}: ${result.stdout}\n${result.stderr}`)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
