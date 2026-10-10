# Lifecycle and event fixture inventory

CORE-10 audit, 10 October 2026. This inventory separates behavior already established from new acceptance work. The [decision record](adr/0001-owned-lifetimes-and-durable-events.md) defines the proposed scope; no lifecycle or event implementation is claimed here.

## Verification in this audit

- Core baseline matches all 79 tracked Git blobs at `b9e0041723e505838d8d3ea154d3db8db0b2914c`
- CLI local tree matches `c0540972ff61c0b4e6bb8a1a7890df1c8bdb412a` at remote `2f94b29f4a3a58ba93cde250d64f60258e086407`
- Desktop local tree matches `27c6885203c37a2a93a3172c430ebbcb50cc5399` at remote `c8b63325b5fbd50b5da2f35ec3c3485815b4dcfb`
- Core build passed with TypeScript 6.0.3 and Node declarations 24.13.3
- Existing focused core files below: 106 tests passed on each Node 22.23.3 and 24.19.0, zero skips
- Added baseline fixture below: three tests passed on each runtime, zero skips
- CLI: `test/extensions.test.mjs` and `test/usage-pure.test.mjs`, 21 passed; one additional owned in-memory callback-lifetime probe reproduced late settlement without changing canonical history; the candidate-lease fixture below passed one case
- Desktop: exactly four selected ordinary tests passed; 34 unselected cases were skipped by the name filter. These cover valid calculator registration, admitted persistence drain, transient progress isolation and authoritative usage replacement

This was controlled offline evidence. No full host suite or restricted assessment was resumed, and no physical GUI, user computer, live provider, Discord or external MCP service was exercised. Seven historical CLI assessment exclusions and 45 Desktop assessment exclusions remain separate. Existing broader release/CI evidence is recorded in the product roadmaps, not inferred from these focused checks.

## CLI candidate lease reproducer

[`docs/fixtures/cli-candidate-lease.test.mjs`](fixtures/cli-candidate-lease.test.mjs) runs against the audited CLI build, selected with `VIVI_CLI_AUDIT_ROOT=/path/to/vivi-cli`. It patches fake store/lease/preference/outcome methods in memory, uses fake IO and an inert manager, and asserts if provider, credential, metadata, approval or native paths are entered. It reproduces previous-host cleanup rejection after candidate initialization: two leases acquired, only the old lease released, no candidate shutdown, old displayed/application owner retained and zero provider generations. Physical `.json.lock` retention follows the real acquire/release implementation; this fixture creates no lock files. A separately scoped CLI correction should invert the candidate-leak assertions and add initialization/closed-IO cleanup cases.

## Existing core fixtures

- [`test/extensions.test.mjs`](https://github.com/ayayaQ/vivi/blob/b9e0041723e505838d8d3ea154d3db8db0b2914c/test/extensions.test.mjs): nine cases for malformed registration, reserved/duplicate names, frozen schemas and captured functions, synchronous validation, abort and late settlement
- [`test/agent.test.mjs`](https://github.com/ayayaQ/vivi/blob/b9e0041723e505838d8d3ea154d3db8db0b2914c/test/agent.test.mjs): acceptance before dispatch, sequential results, all four callback failure boundaries, cancellation during provider/tool/hook waits and final history/usage preservation
- [`test/history.test.mjs`](https://github.com/ayayaQ/vivi/blob/b9e0041723e505838d8d3ea154d3db8db0b2914c/test/history.test.mjs): matched interrupted closure, unchanged completed results, rejection of duplicate/out-of-order/orphaned history, no replay
- [`test/progress.test.mjs`](https://github.com/ayayaQ/vivi/blob/b9e0041723e505838d8d3ea154d3db8db0b2914c/test/progress.test.mjs): immutable ordered transient deltas, draining unawaited progress, obsolete callbacks, cancellation and listener release
- [`test/cache-usage.test.mjs`](https://github.com/ayayaQ/vivi/blob/b9e0041723e505838d8d3ea154d3db8db0b2914c/test/cache-usage.test.mjs): mocked provider usage, independent optional cache completeness, overflow checks and accepted-round totals after cancellation/hook error
- [`test/mcp-extension.test.mjs`](https://github.com/ayayaQ/vivi/blob/b9e0041723e505838d8d3ea154d3db8db0b2914c/test/mcp-extension.test.mjs): two owned host fakes, captured metadata, denied/stale/unknown effects and preserved source/untrusted/doNotRetry fields

The added [`test/lifecycle-event-baseline.test.mjs`](../test/lifecycle-event-baseline.test.mjs) makes three migration premises explicit: hook failure can retain accepted history/usage without later callbacks; `tool_started` can occur without dispatch; and an already-entered trusted callback may settle after the runner cancels. These are expected current semantics. A future durable feed must cover settlement separately, while scopes and host callbacks own safe quiescence.

## Host fixtures to reuse

These were inspected unless expressly listed as rerun above.

CLI at `2f94b29f`:

- [`extensions.test.mjs`](https://github.com/ayayaQ/vivi-cli/blob/2f94b29f4a3a58ba93cde250d64f60258e086407/test/extensions.test.mjs): shared calculator, fixed capture before save, disabled built-in reservations, late extension result and model tool-support gating
- [`usage-pure.test.mjs`](https://github.com/ayayaQ/vivi-cli/blob/2f94b29f4a3a58ba93cde250d64f60258e086407/test/usage-pure.test.mjs): independent counts/cache completeness and safe immutable aggregation
- Session/application/host/MCP fixture suites: candidate lease acquisition, ordinary session switch and final cleanup; saved IDs/titles/notes; canonical interrupted recovery; exact accepted/intent/settled sidecar reconciliation; drain and secret withholding. Select ordinary cases explicitly when reproducing startup rollback; do not infer these all passed from the two focused files

Desktop at `c8b63325`:

- [`agentExtensions.test.ts`](https://github.com/ayayaQ/bot-commander-desktop/blob/c8b63325b5fbd50b5da2f35ec3c3485815b4dcfb/src/main/services/agentExtensions.test.ts), `agentService.test.ts`, `agentExtensions.integration.test.ts`: frozen per-run capture, reserved names/collision before state mutation, cancellation and owned fake-provider continuation
- [`agentPersistenceLifecycle.test.ts`](https://github.com/ayayaQ/bot-commander-desktop/blob/c8b63325b5fbd50b5da2f35ec3c3485815b4dcfb/src/main/services/agentPersistenceLifecycle.test.ts), `agentPersistence.integration.test.ts`, `agentHistory.test.ts`: ingress pause/drain/reopen, interrupted checkpoints, concurrent metadata, failed-terminal retry and legacy no-replay migration
- [`agentRunMetrics.test.ts`](https://github.com/ayayaQ/bot-commander-desktop/blob/c8b63325b5fbd50b5da2f35ec3c3485815b4dcfb/src/shared/agentRunMetrics.test.ts), `agentProgress.test.ts`: final usage replacement, partial metrics, bounded transient text and run checks
- [`agentMcpOutcomes.test.ts`](https://github.com/ayayaQ/bot-commander-desktop/blob/c8b63325b5fbd50b5da2f35ec3c3485815b4dcfb/src/main/services/agentMcpOutcomes.test.ts), `agentMcpService.test.ts`, `agentMcpWorkflow.integration.test.ts`: owned transport rollback, retained cleanup owner, exact human review, durable intent/outcome and checkpoint acknowledgement
- Renderer `agentMcp.test.ts`, `index.test.ts` and `gracefulShutdown.test.ts`: subscription generation, launch cancellation, app-level revocation, drain and failure resume

## Shared acceptance corpus to add

### CORE-11 with CLI-19 and DESKTOP-13

1. Repeated create/register/snapshot/run/cancel/dispose leaves no owned callback or registration live
2. Duplicate/reserved/disabled names cannot replace tools; static v1 consumers stay unchanged
3. Partial activation rolls back only acquired candidate resources in reverse order; established neighboring scopes survive and late acquisition after closure is immediately cleaned up
4. Closing immediately rejects registration and fresh dispatch; immutable active catalog contents never hot-swap
5. Concurrent/repeated disposal awaits one memoized success or failure; every cleanup callback is attempted and errors remain observable without reopening registration
6. Old callback entry is inert; callbacks already entered retain host cancellation/revision checks after awaits; registered cleanup and admitted durable effects are drained under host policy without awaiting arbitrary uncooperative executor promises
7. Session replacement/shutdown awaits admitted event work and owned lease/resource cleanup, including failed candidate initialization and previous-owner shutdown
8. A cancelled/disposed run does not close app-owned MCP connections, restore approval or widen tool eligibility

### CORE-12 with CLI-20 and DESKTOP-14

1. Full replay, incremental fold and fresh reload produce identical immutable history/outcomes/usage
2. Success, denial, not-attempted cancellation, confirmed effects and unknown effects remain distinct; `tool_started` proves none of them
3. Accepted usage survives cancellation/hook failure; final settlement replaces interim totals without double addition, and omitted cache counts stay unreported
4. Partial streams remain transient; terminal closure is durable even without live callback delivery
5. Identical duplicates are idempotent; conflicting identity, sequence gaps, corrupt records and unknown versions stop safely without empty-history fallback
6. Failed checkpoint before/after commit preserves stronger outcome evidence; exact acknowledgement never deletes the last durable receipt
7. Legacy import preserves IDs/titles/notes/aggregate usage and original records; missing round/provenance data is marked unknown rather than invented
8. Snapshot watermark plus event cursor prevents older list responses or prior-run terminal frames replacing newer state
9. Long waits retain source references/pending work/cursor; resume revalidates policy/revisions and never restores approvals or dispatches historical effects
10. Privacy-only rewrites retain receipt identity bridges; newly recognized credentials and deleted/disabled context never reappear through replay

### CORE-13 with CLI-21 and DESKTOP-15

Use the same request/result corpus for bounded text and structured data, long/collapsed/truncated output, unknown kinds, denial, cancelled/no-send, confirmed failure and unknown-effect warnings. Preserve source/provenance and required human review. Renderers receive data only and cannot execute foreign components or grant rights.
