# Owned extension lifetimes and durable event projections

Status: Proposed after CORE-10 audit, 10 October 2026

## Decision

Keep Vivi's bounded headless loop and explicitly imported v1 extensions. Add a small opt-in registration lifetime in CORE-11; develop versioned committed records and pure projections separately in CORE-12. Neither change replaces the hosts' current approval, persistence, MCP send authority or outcome ledgers. CORE-13 follows with tool presentation data, not a UI plugin framework.

The first implementation PR is lifecycle-only. Existing `ToolExtension`, `createToolRegistry`, `runAgent` and live `onEvent` behavior remain compatible. Publication and byte-verified registry adoption are separate gates before either host changes its dependency.

## Audited baseline

- Core: [`b9e00417`](https://github.com/ayayaQ/vivi/commit/b9e0041723e505838d8d3ea154d3db8db0b2914c), published `@ayayaq/vivi` 0.9.0
- CLI: [`2f94b29f`](https://github.com/ayayaQ/vivi-cli/commit/2f94b29f4a3a58ba93cde250d64f60258e086407)
- Desktop: [`c8b63325`](https://github.com/ayayaQ/bot-commander-desktop/commit/c8b63325b5fbd50b5da2f35ec3c3485815b4dcfb)

Remote mains and local host trees were verified. All 79 tracked core files were compared with the remote Git blob hashes before adding this record. The audit reran 106 focused existing core tests on each Node 22/24 runtime and three owned offline contract probes on each runtime. See [fixture inventory](../LIFECYCLE_EVENT_FIXTURES.md) for host evidence and limits.

## Existing guarantees to retain

The [registry](https://github.com/ayayaQ/vivi/blob/b9e0041723e505838d8d3ea154d3db8db0b2914c/src/extensions.ts#L54-L139) captures validator/executor references and freezes detached schemas per turn. Duplicate IDs, reserved names and malformed contracts fail before dispatch. Both hosts reserve disabled built-in names and gate advertisements by actual model capabilities. Trusted extension code has no sandbox or permission grant.

The [loop](https://github.com/ayayaQ/vivi/blob/b9e0041723e505838d8d3ea154d3db8db0b2914c/src/run-agent.ts#L279-L351) validates provider output before acceptance, commits assistant messages before tools, executes calls sequentially, and closes pending calls on cancellation/error. Progress is transient; callbacks are ordered, awaited and frozen. Final `AgentResult` is authoritative for accepted history and usage, including when a callback failed or cancellation suppressed later callbacks. Late settlements cannot change that returned transcript.

CLI checkpoints canonical assistant/results/usage before display, then reconciles the final result. Desktop maintains canonical history plus richer display records and replaces interim metrics with final usage. Both recover interrupted calls without executing them and deliberately omit prior memory/skill context from reusable history.

Both MCP ledgers already bind exact session/run/call identities and arguments, record durable intent before actual send, settle outcomes, and retire evidence only after matching checkpointed history. They distinguish no-send, confirmed and unknown effects. [CLI terminal reconciliation](https://github.com/ayayaQ/vivi-cli/blob/2f94b29f4a3a58ba93cde250d64f60258e086407/src/host.ts#L1008-L1062) and [Desktop terminal reconciliation](https://github.com/ayayaQ/bot-commander-desktop/blob/c8b63325b5fbd50b5da2f35ec3c3485815b4dcfb/src/main/services/agentService.ts#L1563-L1618) preserve these facts after cancellation and checkpoint failure. Do not introduce a competing delivery ledger or infer an effect from `tool_started`.

## Actual gaps and owners

1. **Reusable cleanup ownership.** [The extension contract](https://github.com/ayayaQ/vivi/blob/b9e0041723e505838d8d3ea154d3db8db0b2914c/src/extensions.ts#L13-L25) has no activation, disposal or owned callback contract. Hosts hand-code cleanup. A CLI in-memory probe showed a non-MCP asynchronous display callback settling after the next turn and shutdown; canonical history stayed correct. An ordinary in-memory CLI startup fixture also reproduced a candidate lease remaining acquired if previous-host shutdown rejects before candidate publication ([application lines 470–524](https://github.com/ayayaQ/vivi-cli/blob/2f94b29f4a3a58ba93cde250d64f60258e086407/src/application.ts#L470-L524)). Desktop's static calculator/skills registrations have no demonstrated leak; its callback subscriptions supply a concrete ownership adapter, not evidence for a wholesale rewrite.
2. **Replay-complete committed records.** [AgentEvent](https://github.com/ayayaQ/vivi/blob/b9e0041723e505838d8d3ea154d3db8db0b2914c/src/types.ts#L74-L106) has no version, event/sequence/run/session envelope or terminal settlement. Cancellation closures and already accepted usage may exist only in `AgentResult`. It is a live feed, not a durable journal. Hosts own checkpoint durability; core acceptance alone cannot certify disk commit.
3. **Consumer ordering.** [Desktop IPC events](https://github.com/ayayaQ/bot-commander-desktop/blob/c8b63325b5fbd50b5da2f35ec3c3485815b4dcfb/src/shared/agentTypes.ts#L149-L167) have optional run identity and no watermark. [Renderer subscription followed by an unguarded snapshot replacement](https://github.com/ayayaQ/bot-commander-desktop/blob/c8b63325b5fbd50b5da2f35ec3c3485815b4dcfb/src/renderer/src/stores/agent.ts#L115-L124) admits an older-snapshot/newer-event race by construction. This is a contract gap, not a reproduced native failure.
4. **Presentation.** Tool results remain strings; both hosts parse domain JSON and combine result, approval and provenance for their own UI. Share bounded data and explicit uncertainty in CORE-13, while retaining host-specific controls and safe text fallback.

## Small implementation slices

### CORE-11 and its two consumers

Add one explicit trusted registration scope with an opaque owner identity, open/closing/closed state, cancellation/liveness checks, owned v1 registrations and host-provided cleanup callbacks. Closing rejects new registrations and new dispatch through retained snapshots without rewriting advertised schemas. Hosts cancel existing turns before final disposal and drain registered cleanup/admitted durable effects, rather than awaiting every uncooperative generic executor. Concurrent disposal shares one completion; cleanup runs in reverse acquisition order, attempts every callback and reports all failures. Its success or rejection is memoized; a failed cleanup never reopens registration or hides a host-retained retryable resource owner. Failed setup rolls back only its candidate scope. An acquisition settling after closure must be cleaned up immediately, never adopted by a later owner. No generic event bus, context hierarchy, process supervisor or executable loader is needed.

CLI-19 uses app/session/run ownership for candidate leases, imported tools and event work, preserving current MCP/command/memory drains. DESKTOP-13 uses run registrations and explicit listener unsubscribe ownership; app-owned MCP connections outlive a run. Both run the same small lifecycle corpus. Callback wrappers can reject late entry, but cannot stop arbitrary trusted code after it has entered: host callbacks must recheck owner/signal after awaits and retain admitted effects until settled.

### CORE-12 and its two consumers

Start with bounded v1 record decoding and pure full/incremental history/outcome/usage folds. Give records stable event/session/run/call identity, explicit order and source provenance; keep text deltas and provisional UI state separate. Accept terminal settlement from final reconciled host results, including cancellation and hook failure. Preserve the difference between not-attempted and unknown effects using existing exact host outcome evidence. Duplicate identical records are idempotent; conflicting duplicates, gaps and unsupported versions stop catch-up safely.

CLI-20 and DESKTOP-14 first compare projections in shadow fixtures, then add host-owned commit adapters and migration. Preserve original session IDs, call IDs, notes, titles, display/validation evidence and aggregate usage. Import legacy snapshots with stable source references; do not invent missing historical round IDs, per-round usage or approvals. CLI's closed schema-1 decoder needs an explicitly versioned successor. Keep original data recoverable until the successor is validated and durably committed. Existing MCP sidecars remain authoritative until exact migrated checkpoint acknowledgement; replay never dispatches tools, starts servers or restores permits.

Long approval pauses may persist bounded pending-work descriptions, source revisions and a safe-resume cursor. They do not persist reusable approval. Resume revalidates resources, policy and current sources. Credential screening, memory deletion/invalidation, physical append/fsync/backup/quarantine policy and process ownership remain host responsibilities.

## Reference and deferred work

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/architecture.md) demonstrates scoped teardown and distinct live/durable projections. Reuse those principles; do not adopt its Cordis configuration, replaceable-loop composition, UI slots or arbitrary plugin loading. CORE-14 remains an offline optional hierarchical-context experiment alongside explicit app-wide memory, with provenance/invalidation and quality/cost/latency evidence before a shipping decision.

No product decision blocks the lifecycle-only PR. Persistent format details and unknown-version behavior need exact independent contract review before CORE-12 adoption. Existing Auto eligibility, hard denies, human MCP approval, disabled skill saving, native/live gates and restricted-assessment exclusions remain in force.
