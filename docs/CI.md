# Continuous integration

`Core checks` runs for pull requests and pushes to `main`. Branch pushes do not
also run a duplicate copy of pull-request checks. New runs cancel older runs for
the same pull request; each main push retains its own run.

## Checks and coverage

- **Linux correctness and package (Node 22 / 24):** `npm run check` builds once,
  runs every existing `test/*.test.mjs` test, all 11 offline examples, and packed
  ESM/CommonJS runtime and TypeScript consumer checks.
- **Windows compatibility (Node 22 / 24):** the existing MCP, extension scope,
  records, stream, privacy, presentation, questions, context, and steering tests,
  six examples, and CommonJS smoke checks. The selected test scope is unchanged.
- **Prepared-action Lean verification:** the existing checksum-pinned Lean
  4.34.0 install, kernel proofs, trust audit, and actual TypeScript conformance
  on Node 24. Proof files, source mapping, and the standalone
  `npm run verify:prepared-action` command are unchanged.
- **CI summary:** waits for both matrices and Lean, and succeeds only if all
  three job results are `success`. Failures, cancellations, skipped jobs, or
  missing/unexpected dependency results cannot produce a passing summary.

There are five execution jobs plus one lightweight summary job. Previously,
there were five execution jobs across two workflows. Per complete event, full
build invocations decrease from nine to five: Linux 6 → 2, Windows 2 → 2, and
Lean 1 → 1. A branch push with an open PR previously scheduled both push and PR
copies (ten execution jobs, eighteen builds); it now schedules one PR copy
(five execution jobs, five builds, plus the summary).

`npm test`, `npm run example`, and `npm run test:package` remain self-contained:
each builds before running its checks. Their `:built` variants require an
already completed build and are composed by `npm run check` to avoid rebuilding
identical artifacts. Do not use `:built` commands against stale build output.

The summary is a status result, not branch protection. This change does not
alter repository settings or enforce merge rules. Job display names have become
more descriptive; maintainers using required-check settings should review the
names separately before requiring the summary. CODEOWNERS routes review of the
consolidated workflow to the same owner as the former Lean workflow.
