import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runPackageContracts } from '../scripts/test-package-contracts.mjs'
import { runProcess } from '../scripts/package-process.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vivi contract runner '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'test/package-contracts')
  const temporary = join(root, 'installed consumer')
  await mkdir(source, { recursive: true })
  await mkdir(temporary)
  const manifest = { version: 1, runtime: ['runtime.mjs', 'runtime.cjs'],
    types: ['types.mts', 'types.cts'], coverage: { plumbing: ['runtime.mjs', 'types.mts'] } }
  async function save() {
    await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
  }
  for (const entry of [...manifest.runtime, ...manifest.types]) await writeFile(join(source, entry), '')
  return { root, source, temporary, manifest, save }
}

test('absent A2 manifest leaves existing package checks usable', async t => {
  const { root, temporary } = await fixture(t)
  assert.deepEqual(await runPackageContracts({ root, temporary, run() { assert.fail('unexpected spawn') } }),
    { runtime: 0, types: 0 })
})

test('copies fixtures into installed consumer and registers explicit runtime and strict declaration modes', async t => {
  const { root, temporary, save } = await fixture(t)
  await save()
  const calls = []
  const counts = await runPackageContracts({ root, temporary, run(command, args, cwd) {
    calls.push({ command, args, cwd })
    assert.equal(command, process.execPath)
    assert.equal(cwd, temporary)
    assert(existsSync(args.at(-1)))
    if (args.length === 1) runProcess(command, args, { cwd })
  } })
  assert.deepEqual(counts, { runtime: 2, types: 2 })
  assert.equal(calls.length, 4)
  assert(calls.every(call => call.args.at(-1).startsWith(join(temporary, 'package-contracts'))))
  for (const call of calls.slice(2)) assert.deepEqual(call.args.slice(1, -1),
    ['--strict', '--noEmit', '--module', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM'])
})

test('present invalid JSON fails instead of skipping A2 checks', async t => {
  const { root, source, temporary } = await fixture(t)
  await writeFile(join(source, 'manifest.json'), '{')
  await assert.rejects(runPackageContracts({ root, temporary, run() {} }), SyntaxError)
})

test('rejects traversal, absent modes and unsupported manifest versions', async t => {
  const { root, temporary, manifest, save } = await fixture(t)
  for (const entry of ['../escape.mjs', '/absolute.mjs', 'C:\\escape.mjs', 'nested/../../escape.mjs']) {
    manifest.runtime = [entry, 'runtime.cjs']
    await save()
    await assert.rejects(runPackageContracts({ root, temporary, run() { assert.fail('unexpected spawn') } }), /Invalid runtime/)
  }
  manifest.runtime = ['runtime.mjs']
  await save()
  await assert.rejects(runPackageContracts({ root, temporary, run() {} }), /Missing .cjs/)
  manifest.version = 2
  await save()
  await assert.rejects(runPackageContracts({ root, temporary, run() {} }), /Unsupported/)
})

test('runtime failure stops later fixtures and propagates to harness cleanup', async t => {
  const { root, source, temporary, save } = await fixture(t)
  await writeFile(join(source, 'runtime.mjs'), 'process.exit(29)')
  await save()
  let calls = 0
  await assert.rejects(runPackageContracts({ root, temporary, run(command, args, cwd) {
    calls++
    return runProcess(command, args, { cwd })
  } }), error => error.status === 29)
  assert.equal(calls, 1)
})
