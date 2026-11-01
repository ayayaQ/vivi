import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'

// npm.cmd cannot be spawned without a shell on Windows. Run npm's JavaScript
// entry point with this Node executable instead, including for direct node runs.
export function npmInvocation(args, { env = process.env, execPath = process.execPath } = {}) {
  const candidates = env.npm_execpath ? [env.npm_execpath] : [
    join(dirname(execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    ...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean).flatMap(directory => [
      join(directory, 'node_modules/npm/bin/npm-cli.js'),
      join(directory, 'npm')
    ])
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const cli = realpathSync(candidate)
    if (!cli.endsWith('npm-cli.js')) continue
    return { command: execPath, args: [resolve(cli), ...args] }
  }
  throw new Error('Cannot locate npm-cli.js; run through npm run or install npm alongside Node')
}

export class ProcessFailure extends Error {
  constructor(command, args, result) {
    super(`${command} ${JSON.stringify(args)} failed (${result.error?.code ?? result.signal ?? result.status}): ${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`, { cause: result.error })
    this.status = result.status
    this.signal = result.signal
    this.stdout = result.stdout
    this.stderr = result.stderr
  }
}

export function runProcess(command, args, options = {}) {
  const invocation = command === 'npm' ? npmInvocation(args, options) : { command, args }
  const result = spawnSync(invocation.command, invocation.args, {
    ...options, encoding: 'utf8', shell: false
  })
  if (result.error || result.signal || result.status !== 0) {
    throw new ProcessFailure(invocation.command, invocation.args, result)
  }
  return result.stdout
}

// Called only after the caller's finally block has cleaned up its consumer.
export function reportProcessFailure(error) {
  console.error(error)
  if (error instanceof ProcessFailure && error.signal) {
    process.kill(process.pid, error.signal)
  } else {
    process.exitCode = error instanceof ProcessFailure ? error.status || 1 : 1
  }
}
