# CI coverage and PR cost

The package supports Node.js >=22 (package.json and README). This change is a CI
allocation change, not a runtime support-policy change.

## Pull requests

- Linux Node 22: unchanged `npm run check`: one build, every test, all examples,
  and the complete installed-package runtime and TypeScript consumer suite.
- Linux Node 24: one build, focused installed-package smoke (all 17 public export
  boundaries in ESM/CommonJS and both declaration modes, plus a tiny offline
  agent run), inventory and model-capabilities examples. No full test rerun.
- Windows Node 22: unchanged selected compatibility tests, examples and CJS checks.
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
The one allowed skip is the PR-only smoke job on push/manual runs.
GitHub matrix job results aggregate their required legs; the event-specific
matrix expressions select Node 22 alone for PRs and Node 22/24 otherwise.
