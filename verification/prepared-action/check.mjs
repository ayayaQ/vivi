// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { verifyAudit } from './audit.mjs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, 'source-map.json'), 'utf8'))
for (const [path, digest] of Object.entries(manifest.sha256)) {
  const actual = createHash('sha256').update(readFileSync(join(here, '../..', path))).digest('hex')
  assert.equal(actual, digest, `Source changed: review the Lean mapping and update source-map.json for ${path}`)
}
const lean = process.env.LEAN ?? 'lean'
const version = execFileSync(lean, ['--version'], { encoding: 'utf8' })
assert.match(version, /^Lean \(version 4\.34\.0(?:,|\s)/, 'Use the pinned Lean toolchain')
assert.equal(readFileSync(join(here, 'lean-toolchain'), 'utf8').trim(), 'leanprover/lean4:v4.34.0')
// Defense in depth, not the trust boundary. Transitive kernel axiom reports below
// are checked by exact theorem name; missing/unrecognized output fails closed.
for (const file of readdirSync(here).filter(f => f.endsWith('.lean'))) {
  const source = readFileSync(join(here, file), 'utf8')
  assert.doesNotMatch(source, /\b(sorry|admit|axiom|unsafe|native_decide)\b/, `Forbidden trust extension in ${file}`)
}
const dir = mkdtempSync(join(tmpdir(), 'vivi-lean-'))
const run = args => execFileSync(lean, ['-DwarningAsError=true', ...args], {
  cwd: here, env: { ...process.env, LEAN_PATH: dir }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
})
try {
  run(['-o', join(dir, 'Model.olean'), 'Model.lean'])
  const audit = run(['Audit.lean'])
  verifyAudit(audit)
  console.log(audit.trim())
  const corpus = run(['--run', 'Oracle.lean'])
  // Import fresh compiler output from the real implementation, never a JS reference model.
  const { checkCorpus } = await import('./differential.mjs')
  await checkCorpus(corpus)
} finally { rmSync(dir, { recursive: true, force: true }) }
