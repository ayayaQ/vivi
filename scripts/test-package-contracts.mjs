// A2 owns the assertions under test/package-contracts; A3 owns their execution.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { cp, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export async function runPackageContracts({ root, temporary, run }) {
  const source = join(root, 'test/package-contracts')
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT' || existsSync(source)) throw error
    console.log('Additional package contracts: manifest absent (A2 fixtures not supplied)')
    return { runtime: 0, types: 0 }
  }
  assert.equal(manifest.version, 1, 'Unsupported package contract manifest version')
  for (const [kind, extensions] of [['runtime', ['.mjs', '.cjs']], ['types', ['.mts', '.cts']]]) {
    const entries = manifest[kind]
    assert(Array.isArray(entries) && entries.length > 0, `Missing ${kind} entries`)
    assert.equal(new Set(entries).size, entries.length, `Duplicate ${kind} entry`)
    for (const entry of entries) {
      assert(typeof entry === 'string' && !isAbsolute(entry) && !entry.includes('\\') &&
        entry.split('/').every(part => part && part !== '..' && part !== '.') &&
        extensions.some(extension => entry.endsWith(extension)), `Invalid ${kind} entry: ${entry}`)
    }
    for (const extension of extensions) {
      assert(entries.some(entry => entry.endsWith(extension)), `Missing ${extension} contract`)
    }
  }
  assert(manifest.coverage && typeof manifest.coverage === 'object' && !Array.isArray(manifest.coverage),
    'Missing package contract coverage map')
  const destination = join(temporary, 'package-contracts')
  await cp(source, destination, { recursive: true })
  for (const entry of manifest.runtime) run(process.execPath, [join(destination, entry)], temporary)
  for (const entry of manifest.types) {
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
      '--strict', '--noEmit', '--module', 'NodeNext', '--target', 'ES2022',
      '--lib', 'ES2022,DOM', join(destination, entry)], temporary)
  }
  console.log(`Additional package contracts passed: ${manifest.runtime.length} runtime, ${manifest.types.length} strict type fixtures`)
  return { runtime: manifest.runtime.length, types: manifest.types.length }
}
