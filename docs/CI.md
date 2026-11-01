# Continuous integration

`Core checks` runs for pull requests, pushes to `main`, and manual dispatch. Branch pushes do not
also run a duplicate copy of pull-request checks. New runs cancel older runs for
the same pull request; each main push retains its own run.

## Checks and coverage

- **Linux correctness and package (Node 22 / 24):** `npm run check` builds once,
  runs every existing `test/*.test.mjs` test, all 11 offline examples, and packed
  ESM/CommonJS runtime and TypeScript consumer checks.
- **Windows compatibility (Node 22 / 24):** the existing MCP, extension scope,
  records, stream, privacy, presentation, questions, context, and steering tests,
  six examples, and CommonJS smoke checks, plus focused package process and
  fixture-runner tests and an installed-tarball ESM/CommonJS/TypeScript smoke.
  These reuse the existing Windows build and are required by the summary.
- **Prepared-action Lean verification:** the existing checksum-pinned Lean
  4.34.0 install, kernel proofs, trust audit, and actual TypeScript conformance
  on Node 24. Proof files, source mapping, and the standalone
  `npm run verify:prepared-action` command are unchanged.
- **Linux package smoke (Node 24):** PR-only focused installed-consumer checks,
  package process/fixture-runner tests, inventory and model-capabilities examples.
- **CI summary:** requires Linux correctness, Windows compatibility, and Lean
  success, plus Linux package smoke success on PRs. That PR-only job must be
  skipped on main/manual runs. Failures, cancellations and missing/unexpected
  dependency results fail the summary. Its regression test exercises the exact
  inline gate and verifies required Windows package steps.

Pull requests execute four testing jobs/builds plus the summary. Main/manual
runs execute five testing jobs/builds plus the summary, retaining Node 22/24
Linux and Windows matrices. See [CI_MATRIX.md](CI_MATRIX.md) for the event matrix,
portable npm invocation and optional A2 installed-consumer fixture contract.

`npm test`, `npm run example`, and `npm run test:package` remain self-contained:
each builds before running its checks. Their `:built` variants require an
already completed build and are composed by `npm run check` to avoid rebuilding
identical artifacts. Do not use `:built` commands against stale build output.

The summary is a status result, not branch protection. This change does not
alter repository settings or enforce merge rules. Job display names have become
more descriptive; maintainers using required-check settings should review the
names separately before requiring the summary. CODEOWNERS routes review of the
consolidated workflow to the same owner as the former Lean workflow.
