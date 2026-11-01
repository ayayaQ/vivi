# CI coverage and PR cost

The package supports Node.js >=22 (package.json and README). This change is a CI
allocation change, not a runtime support-policy change.

## Pull requests

- Linux Node 22: unchanged `npm run check`: one build, every test, all examples,
  and the complete installed-package runtime and TypeScript consumer suite.
- Linux Node 24: one build, focused installed-package smoke (all 17 public export
  boundaries in ESM/CommonJS and both declaration modes, plus a tiny offline
  agent run), inventory and model-capabilities examples. No full test rerun.
- Windows Node 22: existing selected compatibility tests, examples and CJS checks,
  plus focused package process/fixture-runner tests and the installed-package
  smoke (all public ESM/CJS runtime and declaration boundaries). The same build
  serves every Windows step; no additional job or full Windows suite is added.
- Prepared-action Lean verification: unchanged Node 24 job, checksum-pinned
  toolchain, kernel proofs, trust audit and TypeScript conformance.
- CI summary: exhaustive regression tests of the actual gate, then strict
  event-specific required-job results.

PR #46 ran 6 jobs and 5 builds per PR: 2 full Linux, 2 Windows, Lean and summary.
This layout runs 5 jobs and 4 builds: 1 full Linux, 1 Linux smoke, 1 Windows,
Lean and summary. Full Linux suite executions fall from 2 to 1; Windows
compatibility executions fall from 2 to 1. Each testing job still builds once.

## Main and manual runs

Main pushes retain both full Linux Node 22/24 jobs and both Windows Node 22/24
compatibility jobs, plus the unchanged Lean job and summary: 6 executed jobs,
5 builds. The PR-only compatibility job appears as intentionally skipped.
Manual dispatch is added with this same broad coverage; there is no schedule.

Main/manual Windows Node 22/24 legs also run the new package smoke and focused
process/fixture-runner tests. The PR Linux Node 24 smoke leg runs those focused
tests too; baseline Linux includes them through the existing full test selector.

No existing tests, examples, package checks, Windows commands, or Lean checks
are removed from main. All old test coverage remains on baseline PR Node 22;
the additional Node 24 correctness/package and Windows checks move to main
(and manual dispatch). The lightweight smoke does not replace the full
package harness on baseline/main.

PR supersession cancellation, independent main runs, read-only permissions,
existing action references, and the single CI entrypoint are preserved.

## Gate regression checks

`python3 scripts/test-ci-policy.py` executes the workflow's exact embedded
summary program against every combination of success/failure/cancelled/skipped
results for PR, push and manual events, missing jobs/results, unexpected jobs,
and an unsupported event. Only success for all required jobs is accepted.
It also checks that the summary includes the Windows job and that its portable
package smoke and focused tests remain required, using the existing single build.
The one allowed skip is the PR-only smoke job on push/manual runs.
GitHub matrix job results aggregate their required legs; the event-specific
matrix expressions select Node 22 alone for PRs and Node 22/24 otherwise.

## Portable installed-consumer harness

`npm run test:package` and `npm run test:package:built` use Node to execute
`npm-cli.js` with separate arguments and `shell: false`. The harness uses npm's
`npm_execpath` when called through npm, otherwise the npm CLI installed alongside
Node or on PATH. It never invokes `npm.cmd` through a shell. Directly running
`node scripts/test-package-smoke.mjs` is supported too. On a PowerShell host that
blocks `npm.ps1`, use `npm.cmd run test:package`; no policy change is needed.

Both harnesses create their installed consumers in paths containing spaces,
capture subprocess output, report npm/package SHA-256 and integrity, and clean
up on failure. Nonzero child status is propagated; POSIX signals are re-raised
after cleanup. The signal test records a Windows skip because Windows reports
termination as an exit status. Hosted Node 22/24, supported newer local Node
versions, and separately assigned native Mac runs must be reported separately.

A2 can supply `test/package-contracts/manifest.json` with `version: 1`, explicit
`runtime` paths (`.mjs` and `.cjs`), explicit `types` paths (`.mts` and `.cts`), and
a `coverage` object mapping public boundaries/capabilities to fixture paths.
Paths are relative to that directory, with no absolute paths or parent traversal.
The full harness copies the fixture directory to the installed consumer and
runs each runtime with Node and each type fixture with strict, no-emit NodeNext,
ES2022/DOM settings. Fixtures resolve the installed tarball, not source imports.
An absent fixture directory is reported and leaves all existing assertions enabled;
once that directory exists, a missing/malformed manifest or failed fixture fails
the package check. A2 owns
fixture assertions and coverage; the bounded smoke retains its existing scope.
