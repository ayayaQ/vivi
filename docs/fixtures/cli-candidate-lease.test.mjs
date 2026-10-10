// SPDX-License-Identifier: Apache-2.0
// Owned offline audit fixture. No product source changes or real service/state paths.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Run against the built audited CLI checkout, not the core package's runtime.
const root = resolve(process.env.VIVI_CLI_AUDIT_ROOT || process.cwd())
const load = name => import(pathToFileURL(join(root, 'dist', `${name}.js`)).href)
const { runApplication, DEFAULT_PREFERENCES } = await load('application')
const { CliHost } = await load('host')
const { FileSessionStore } = await load('session')
const { PreferenceStore } = await load('preferences')
const { FileMcpOutcomeStore } = await load('mcp-outcomes')

function replace(t, object, name, replacement) {
  const original = object[name]
  object[name] = replacement
  t.after(() => { object[name] = original })
  return original
}

test('ordinary fake startup reproduces candidate lease leak when previous host shutdown rejects', async t => {
  const acquired = [], released = [], activeLeases = new Set(), checkpoints = [], hosts = [], shutdowns = []
  const displayed = [], messages = [], lines = ['/new', '/exit']
  let failedOldShutdown = false, generations = 0, managerCloses = 0
  const fixtureError = 'Owned fixture previous-host cleanup failure'
  const forbiddenCalls = []
  const never = label => () => { forbiddenCalls.push(label); assert.fail(`Excluded path invoked: ${label}`) }
  const settings = { ...structuredClone(DEFAULT_PREFERENCES), provider: 'openai', model: 'gpt-4.1',
    enableTools: false, enableNotes: false, enableMemory: false }

  // Entire session and preference state is in memory. No directories or .json.lock files are created.
  replace(t, PreferenceStore.prototype, 'load', async () => structuredClone(settings))
  replace(t, PreferenceStore.prototype, 'save', never('preferences mutation'))
  replace(t, FileSessionStore.prototype, 'acquire', async function (id) {
    assert(!activeLeases.has(id), 'Fixture duplicate lease')
    acquired.push(id); activeLeases.add(id)
    let didRelease = false
    return async () => { assert(!didRelease, 'Fixture release repeated'); didRelease = true; released.push(id); activeLeases.delete(id) }
  })
  replace(t, FileSessionStore.prototype, 'save', async function (session) { checkpoints.push(structuredClone(session)) })
  replace(t, FileSessionStore.prototype, 'load', never('session resume read'))
  replace(t, FileMcpOutcomeStore.prototype, 'load', async () => [])
  replace(t, FileMcpOutcomeStore.prototype, 'save', never('MCP evidence mutation'))

  const initialize = replace(t, CliHost.prototype, 'initialize', async function () {
    hosts.push(this)
    await initialize.call(this)
  })
  const shutdown = replace(t, CliHost.prototype, 'shutdown', async function () {
    shutdowns.push(this)
    await shutdown.call(this)
    // Reject after completing the real inert host cleanup: no command/transport execution is needed.
    if (this === hosts[0] && !failedOldShutdown) { failedOldShutdown = true; throw new Error(fixtureError) }
  })

  const io = {
    isClosed: false, canAutoReview: false,
    async readLine() { return lines.shift() },
    choose: never('dialog'), chooseSearchable: never('model catalog picker'), askText: never('text input'),
    setSession(session) { displayed.push(structuredClone(session)) },
    write(text) { messages.push(text) }, event: never('live turn event'), result: never('model result'),
    approve: never('approval'), onCancel: never('input cancellation'), close: never('native/terminal cleanup')
  }
  const manager = { addSecrets() {}, async close() { managerCloses++ } }
  const options = {
    sessionDirectory: '/__owned_in_memory_fixture_only__', provider: 'openai', model: 'gpt-4.1',
    skillsDirectories: [], enableSkills: false, enableMemory: false, enableTools: false, enableNotes: false,
    enableCommands: false, approvalMode: 'manual', stream: false, maxRounds: 25, reasoningCapabilities: []
  }
  const status = await runApplication({
    io, options, args: ['--no-tools'],
    // This is a noncredential fixture marker only, so loadKey never enters an actual credential store.
    env: { OPENAI_API_KEY: 'owned-offline-noncredential-marker' }, secrets: [],
    credentials: { load: never('credential read'), status: never('credential status'), save: never('credential save') },
    catalog: { list: never('provider metadata fetch') },
    mcpManagerFactory: () => manager,
    providerFactory: () => ({ generate: async () => { generations++; assert.fail('Unexpected provider generation') } })
  })

  assert.deepEqual(forbiddenCalls, [], 'No excluded path may be entered, even if application catches its assertion')
  assert.equal(status, 0)
  assert.equal(acquired.length, 2)
  assert.equal(hosts.length, 2)
  const [oldHost, candidateHost] = hosts
  assert.equal(oldHost.session.id, acquired[0])
  assert.equal(candidateHost.session.id, acquired[1])
  assert.deepEqual(displayed.map(session => session.id), [oldHost.session.id], 'Old host remains the application owner')
  assert.deepEqual(shutdowns, [oldHost, oldHost], 'No cleanup runs for the rejected replacement candidate')
  assert.deepEqual(released, [oldHost.session.id], 'Only the old owner lease is released by outer cleanup')
  assert.deepEqual([...activeLeases], [candidateHost.session.id], 'Candidate lease is leaked')
  assert.deepEqual(checkpoints.map(session => session.id), acquired, 'Candidate successfully initialized before prior shutdown failed')
  assert(messages.some(message => message.includes(fixtureError)))
  assert.equal(generations, 0)
  assert.equal(managerCloses, 1)

  console.log(JSON.stringify({
    acquiredLeases: acquired.length, releasedLeases: released.length, candidateLeaseStillOwned: true,
    candidateCleanupCalls: shutdowns.filter(host => host === candidateHost).length,
    oldHostRemainedOwner: true, providerGenerations: generations, applicationExitStatus: status
  }))
})
