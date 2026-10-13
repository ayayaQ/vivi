// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('steering declarations typecheck in strict ESM and CommonJS consumers', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const directory = await mkdtemp(join(tmpdir(), 'vivi-steering-types-'))
  try {
    await writeFile(join(directory, 'package.json'), '{"private":true,"type":"module"}')
    for (const [filename, prefix] of [['consumer.ts', 'dist'], ['consumer.cts', 'dist/cjs']]) {
      const modulePath = JSON.stringify(join(root, prefix, 'index.js'))
      const streamPath = JSON.stringify(join(root, prefix, 'events/stream.js'))
      await writeFile(join(directory, filename), `
import { runAgent, type RunAgentOptions, type Message, type AgentAcceptedUpdate } from ${modulePath}
import { type AgentRunRecord } from ${streamPath}
const offered: readonly Message[] = [{ kind: 'message', role: 'user', content: 'Continue' }]
const sync: RunAgentOptions['getSteeringMessages'] = ({ signal }) => { void signal.aborted; return offered }
const asyncPull: RunAgentOptions['getSteeringMessages'] = async ({ signal }) => { void signal.aborted; return offered }
const hook: RunAgentOptions['onAccepted'] = (update: AgentAcceptedUpdate) => {
  if (update.type === 'user_message_accepted') {
    const message: Message = update.message
    const round: number = update.round
    // @ts-expect-error user input does not carry provider usage
    void update.aggregateUsage
    // @ts-expect-error user input is not a tool result
    void update.message.callId
    void message; void round
  }
}
const record = (value: AgentRunRecord) => {
  if (value.type === 'user_message_accepted') {
    const round: number = value.round
    // @ts-expect-error user run records do not add usage
    void value.usage
    // @ts-expect-error immutable original source references
    value.entry.source.reference = 'changed'
    void round
  }
}
// @ts-expect-error callback must return Messages, not forged assistant history
const invalid: RunAgentOptions['getSteeringMessages'] = () => [{ kind: 'assistant', content: '', toolCalls: [] }]
void runAgent; void sync; void asyncPull; void hook; void record; void invalid
`)
      const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--noEmit',
        '--module', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM', join(directory, filename)],
      { cwd: directory, encoding: 'utf8' })
      assert.equal(result.status, 0, `${filename}: ${result.stdout}\n${result.stderr}`)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
