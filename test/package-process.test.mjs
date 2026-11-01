import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { npmInvocation, ProcessFailure, runProcess } from '../scripts/package-process.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi process fixture '))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const cli = join(directory, 'npm-cli.js')
  await writeFile(cli, `
const fs = require('node:fs')
const args = process.argv.slice(2)
if (process.env.VIVI_FAKE_DESTINATION) {
  fs.writeFileSync(process.env.VIVI_FAKE_DESTINATION, args[args.indexOf('--pack-destination') + 1])
  console.error('synthetic pack failure')
  process.exit(37)
}
console.log(JSON.stringify({ args, cwd: process.cwd() }))
console.error('captured stderr')
process.exitCode = Number(process.env.VIVI_FAKE_EXIT || 0)
`)
  return { directory, cli, env: { ...process.env, npm_execpath: cli } }
}

test('npm CLI argv, executable and working directory preserve spaces and shell characters', async t => {
  const { directory, cli, env } = await fixture(t)
  const args = ['run', 'path with spaces', 'a&b', '$(not-a-command)', 'quote"value', '%PATH%']
  const invocation = npmInvocation(args, { env })
  assert.equal(invocation.command, process.execPath)
  assert.deepEqual(invocation.args, [cli, ...args])
  assert.deepEqual(JSON.parse(runProcess('npm', args, { cwd: directory, env })), { args, cwd: directory })
})

test('direct-node entry can discover npm alongside Node without npm_execpath', async t => {
  const { directory, cli } = await fixture(t)
  const { mkdir, copyFile } = await import('node:fs/promises')
  const target = join(directory, 'node_modules/npm/bin/npm-cli.js')
  await mkdir(join(directory, 'node_modules/npm/bin'), { recursive: true })
  await copyFile(cli, target)
  assert.deepEqual(npmInvocation(['--version'], { env: {}, execPath: join(directory, 'node') }),
    { command: join(directory, 'node'), args: [target, '--version'] })
})

test('missing npm CLI fails clearly without launching a shell', () => {
  assert.throws(() => npmInvocation([], { env: {}, execPath: join(tmpdir(), 'missing-node', 'node') }),
    /Cannot locate npm-cli.js/)
})

test('nonzero status retains captured stdout, stderr and status', async t => {
  const { directory, env } = await fixture(t)
  assert.throws(() => runProcess('npm', ['failure with spaces'], {
    cwd: directory, env: { ...env, VIVI_FAKE_EXIT: '37' }
  }), error => error instanceof ProcessFailure && error.status === 37 && error.signal === null &&
    JSON.parse(error.stdout).args[0] === 'failure with spaces' && /captured stderr/.test(error.stderr))
})

test('spawn errors retain the original cause', () => {
  assert.throws(() => runProcess(join(tmpdir(), 'vivi-does-not-exist.exe'), []),
    error => error instanceof ProcessFailure && error.cause.code === 'ENOENT' && error.status === null)
})

test('signal termination is retained', { skip: process.platform === 'win32' ? 'Windows reports termination as an exit status' : false }, () => {
  assert.throws(() => runProcess(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"]),
    error => error instanceof ProcessFailure && error.signal === 'SIGTERM' && error.status === null)
})

for (const script of ['test-package.mjs', 'test-package-smoke.mjs']) {
  test(`${script} propagates npm failure status after cleaning its spaced consumer path`, async t => {
    const { directory, env } = await fixture(t)
    const record = join(directory, 'destination.txt')
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../scripts/${script}`, import.meta.url))], {
      env: { ...env, VIVI_FAKE_DESTINATION: record }, encoding: 'utf8', shell: false
    })
    assert.equal(result.status, 37, result.stderr)
    assert.match(result.stderr, /synthetic pack failure/)
    const destination = await readFile(record, 'utf8')
    assert.match(destination, /vivi .*consumer /)
    assert.equal(existsSync(destination), false, 'consumer removed after failed npm pack')
  })
}
