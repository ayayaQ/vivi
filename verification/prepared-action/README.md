# Prepared-action routing verification

This is a repository-only verification layer, not a replacement runtime or a
proof of the entire approval system. Production TypeScript is unchanged.
The selected seam is the exported `routePreparedAction` function in
`src/decisions/actions.ts` (baseline main commit
`1a8459093e68f1965b7819173a5c36280351f2ca`).

## Safety specification

For every finite list of **validated, trusted host-prepared effects**:

1. A `blocked` review wins over every other classification and completeness.
2. In the absence of `blocked`, a `manual` review wins over all later checks.
3. An `auto-read` route requires a complete, nonempty effect list, without
   unknown effects or invalid ordinary-read classifications.
4. Every effect in an `auto-read` list is a workspace `read`, explicitly
   classified `ordinary-read` by the host.

These are `blocked_precedence`, `manual_precedence`, `auto_read_guards`, and
`auto_read_effects` in `Model.lean`. They quantify over arbitrary effect lists;
no fixed list length or finite test corpus is used in their proofs.

An automatic route is **not** permission, approval, or authority to execute.
Truthful host classification and target resolution remain assumptions.
Grant binding, cancellation, concurrency, stale evidence, run-state transitions,
provider responses, data transmission permissions and tool execution are NOT
proved by this integration.

## Exact boundary and source mapping

- `actions.ts`: the TypeScript first copies and validates the full snapshot.
  The Lean `routeOptional` models absence of prepared metadata; `route` models
  the following precedence: blocked, manual, incomplete/empty, unknown,
  misclassified ordinary-read, all ordinary-read, otherwise model review.
- `types.ts`: Kind, Scope, and Review enumerate every currently accepted
  string value. Lean `outsideWorkspace` maps to `outside-workspace`,
  `ordinaryRead` to `ordinary-read`, and `modelReview` to `model-review`.
- `validation.ts`: validation and JSON copying are outside the proof. Successful
  validation restricts effects to those enums, boolean completeness, at most
  256 entries, and resource IDs present in `resourceRevisions`. Resource IDs,
  affected data, identity/revisions and other snapshot fields are projected
  away only AFTER validation: they do not affect subsequent routing.
- Missing metadata is valid and routes manual/missing_metadata. Present
  metadata with missing effects, explicit undefined, unsupported enum strings,
  getters, cycles and other invalid shapes routes manual/invalid_snapshot.
  Empty effects are valid and route incomplete_effects. These distinctions
  have tests against the actual validation path, not invented model values.

`source-map.json` records exact source digests. Source drift fails the check
until a reviewer reassesses the mapping and deliberately updates the manifest.
It is a review tripwire, not a formal proof of TypeScript/model equivalence.

## Reproduce

Prerequisites: Node 24 (repository supports >=22), locked npm dependencies,
and the exact Lean 4.34.0 release. No extra Lean packages or live APIs are used.

```sh
npm ci
bash verification/prepared-action/install-lean.sh /tmp/vivi-lean-install
LEAN=/tmp/vivi-lean-install/lean-4.34.0-linux/bin/lean npm run verify:prepared-action
node --test test/decisions-actions.test.mjs
```

The Linux x86_64 installer downloads the official distribution and verifies its
pinned SHA-256 before extraction. Use a new install directory. Other platforms
can use their existing elan installation with the committed `lean-toolchain`;
set `LEAN` to that version's executable when invoking the repository command.
The check rejects version mismatch and builds fresh temporary `.olean` files,
ignoring stale local proof output. The npm command first rebuilds real
TypeScript (both ESM and CJS); the conformance harness imports ESM compiler
output, never a duplicate TypeScript reference implementation.

The command runs:

- Exact-name, fail-closed axiom-audit self-tests (missing, duplicate, renamed,
  unrecognized output and unexpected-axiom reports must fail).
- Lean kernel proof checking with warnings treated as errors. Each required
  theorem's transitive axiom report must contain only the explicit standard
  Lean allowlist: `propext`, `Classical.choice`, `Quot.sound`. No additional
  local axioms, proof placeholders, unsafe code or native_decide are accepted.
- Fresh Lean-generated oracle outputs for 10,499 validated snapshots: every
  64-way effect combination, every ordered pair under both completeness
  values, empty/missing cases, repetitions to the 256-effect boundary, and
  2,048 deterministic longer-list cases. Every routing reason is required.
- Actual TypeScript comparisons of both route and reason, frozen outputs and
  unchanged inputs, plus 32 malformed-input tests outside the theorem boundary.

The finite differential suite is implementation evidence, not a proof that all
JavaScript inputs conform. Compiler correctness, the runtime and Lean toolchain
remain trusted. No network providers, credentials, or executing tools are used.

## Maintenance and review protection

Keep this specification independent of runtime changes: do not weaken a theorem
or mirror a new implementation branch merely to make a check pass. First decide
whether the intended routing contract changed, then review the model, proof,
source map and generator/encoding changes together. Changes to validation must
reassess the abstraction boundary. Preserve all enum and precedence coverage.

CODEOWNERS requests the repository owner's review for this folder, mapped source,
the workflow, package command and CODEOWNERS itself. Enforced protection requires
a repository administrator to require code-owner review and the
`CI summary` check from `Core checks` on the protected branch. The summary
requires Linux, Windows, and Lean success. Existing required-check names need
separate administrator review; this change does not configure repository settings. Without those
settings, ownership and source hashes are review aids, not an enforcement claim.

The Linux Lean job in `Core checks` pins action commits and Lean archive bytes.
It runs on main pushes and PRs without secrets or write permissions. Local
passing checks do not establish that hosted CI has run. Runtime check coverage
is unchanged; see [CI](../../docs/CI.md) for job names and build reuse.
The npm publish allowlist excludes `verification/` and `.github/`, so no Lean
binary/proof tool or model is shipped to users. `verify:prepared-action` is a
repository maintenance command, not a command supported in an installed package.
