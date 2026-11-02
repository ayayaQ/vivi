# Changelog

## Unreleased

- Reconcile repository version and installation guidance with published `0.17.0`; preserve
  its original metadata patch and historical receipt with portable verification instructions.
  This documentation/metadata reconciliation adds no runtime or dependency changes.

## 0.17.0 (published; registry verified 2026-11-01)

- Add an opt-in trusted synchronous OpenAI Responses request projection, shared by estimation
  and dispatch, with detached JSON input/output and fail-closed validation. Default API-key
  behavior is unchanged.
- Add optional bounded, sanitized provider error details for host-side recovery; raw provider
  messages and bodies are not exposed. Authentication, account storage and approval policy
  remain host-owned; this core release does not add ChatGPT sign-in or Skip permissions UI.


- Validate Claude reasoning replay against persisted hashes of the preceding request context,
  tools and reasoning settings. Preserve valid native continuation across provider recreation
  and JSON persistence; omit stale or legacy unbound reasoning from request views after context
  changes, without editing canonical history or native tool identities.
- Use the same reasoning projection for OpenRouter estimation, streaming and non-streaming
  dispatch. Other providers retain their existing replay behavior; no automatic retries or
  additional network requests are introduced.

## 0.16.0 (published)

- Include fresh host-owned dispatch context prefixes, image-bearing tool observations and
  optional queued-message steering. Hosts retain permissions, storage, queue acknowledgement
  and force-send cancellation. These features are also included in published `0.17.0`.

## Historical 0.15.1 preparation (2026-10-21)

This heading preserves the earlier preparation record, not a claim about a separate
`0.15.1` publication. The fixes below are included in published `0.17.0`.

- Honor provider-aware output reservations, including DeepSeek thinking and summary budgets, while preserving explicit host bounds and catalog ceilings
- Report sanitized DeepSeek incomplete finish reasons without accepting partial tool calls or retrying failed output

## 0.15.0 (2026-10-18)

- Add optional `/web` retrieval contracts and `/web/deepseek` standalone Search/Fetch adapter,
  separate from model providers, with bounded untrusted results, honest local truncation,
  cancellation, sanitized errors and uncertain-request outcomes
- Keep paid-provider selection, credentials, privacy/URL approvals, retry policy and host
  adoption explicit; no new dependencies, live provider calls, fallback or npm publication
- Add an optional DeepSeek Chat Completions model provider with exact native
  reasoning/tool continuation, streaming, cache-hit usage, context estimation,
  bounded tool-free summaries, and conservative host-catalog capability metadata
- Keep chat generation independent of web retrieval and approval-decision providers

## 0.14.0 (2026-10-18)

- Add complete provider-projected context estimates, honest known/unknown capacity metadata,
  output reservation and pure next-request measurement independent of cumulative usage
- Add opt-in automatic/manual portable compaction with separate source/projection-bound
  checkpoints, preserved current instructions and complete recent tool groups, and immutable
  summary inputs using the same model with tools disabled
- Preserve canonical raw history and host approval/outcome authority; report summary usage
  separately and allow one strictly smaller retry after classified context overflow
- Preserve compacted-away canonical tool IDs for provider normalization, avoid redundant or
  futile compaction, and cover cancellation, crash/resume, privacy, model switches and failure
- No new runtime dependencies, live providers, npm publication or host adoption are included

## 0.13.0 (2026-10-13)

- Add opt-in exact scalar MCP resource-template reads with a trusted synchronous
  no-I/O expander, immutable template/value/expanded-URI binding, fresh expansion
  checks and a pure exact wire-request projection. Concrete reads stay unchanged
- Quarantine malformed/unsupported templates; cover offline CLI/Desktop one-shot
  sends, denial, stale metadata, Unicode escaping, privacy and unknown outcomes.
  No transport SDK runtime dependency, live MCP, publication or host adoption

## 0.12.0 (2026-10-12)

- Add the opt-in `/extensions/questions` clarification tool with bounded choices, free text,
  explicit skip/cancel, frozen request snapshots, exact response binding and abort-aware FIFO
  waits. Hosts retain human-input UI, owner/run lifecycle and the shared approval-dialog queue
- Add offline CLI/Desktop-shaped hosts and packaged ESM/CommonJS/type consumers. No default
  registration, action authorization, host adoption or publication is included
- Retain the offline CORE-14 source experiment and documentation; it adds no public export
  or runtime context-selection behavior. Runtime dependencies remain unchanged

## 0.11.0 (2026-10-10)

- Add optional `/presentation` bounded display-only tool snapshots, safe plain-text views,
  and paired CLI/Desktop fixtures; status, effect warnings and provenance remain outside
  collapsed/truncated details. No host UI, execution, consent or production adapter changes

## 0.10.0 (2026-10-10)

- Add bounded opt-in terminal records and pure immutable full/incremental snapshot projections
  on `/events`; retain final reconciled history/usage, exact host outcome evidence and live callback compatibility
- Add an opt-in canonical accepted-update hook and bounded `/events/stream` run-local deltas,
  with exact session anchors, frozen replay, usage and terminal reconciliation
- Prove paired offline host append/checkpoint/recovery, privacy and cursor seams;
  production CLI-20/Desktop-14 migration follows verified publication
- Require bounded complete-chain replay; no mid-log bootstrap, compaction or receipt retirement

- Add opt-in owned extension scopes with atomic registration, fixed lifetime-bound snapshots,
  combined cancellation and one awaited reverse-cleanup completion, including aggregate failures
- Cover late acquisitions, candidate rollback and owned CLI/Desktop listener/persistence adapters
  offline; host permissions, domain cleanup, MCP connections and durable outcome ledgers stay host-owned

## 0.9.0 (2026-10-10)

- Add optional dependency-free MCP catalog, operation-binding, fixed extension and
  bounded untrusted-result helpers with mandatory host review/schema/privacy wiring
- Keep connections, processes, credentials, actual sends and approval UI host-owned;
  add a metadata-only host capability and offline paired-host adapter checks
- Publish the reviewed archive; registry metadata, exact bytes and all 262 installed files
  are verified on Node 22/24 before separately reviewed host adoption

## 0.8.0 (2026-10-08)

- Add optional host-prepared effect metadata and deterministic review routing to `/decisions`
- Bind concrete targets, affected-data evidence, and trusted classifications to existing frozen
  snapshots/currentness; keep access, privacy, target resolution, and execution in hosts
- Cover mixed/unknown effects, exact stale metadata, and offline ESM/CommonJS/type consumers;
  no filesystem tool or host integration included
- Publish the exact reviewed archive; registry bytes, all 215 installed files, nine ESM/CommonJS
  subpaths, strict NodeNext declarations and 63 installed decisions/routing tests pass on Node 22/24
- Host adoption remains separately reviewed; mock checks do not calibrate live models

## 0.7.0 (2026-10-08)

- Add an optional `@ayayaq/vivi/decisions` module with frozen exact-action/request/revision
  binding, host-authored named requirements, explicit provider-specific thresholds,
  fail-closed `allow` / `ask` / `deny` recommendations, deadlines/cancellation, coded reasons,
  and dedicated OpenAI Decisions / OpenRouter Jev adapters
- Add mocked wire/safety tests, packed ESM/CommonJS/declaration consumers and an offline
  shadow-review example; no host approval policy, automatic execution, or live API calls
- Publish the exact reviewed archive; registry bytes, all 206 installed files, all nine
  ESM/CommonJS subpaths and strict NodeNext declarations are verified on Node 22 and 24
- Desktop/CLI adoption remains separately reviewed; mock checks do not calibrate live models

## 0.6.0 (prepared; not yet published)

- Add an optional shared instruction-only Agent Skills catalog/parser and list/read tools
- Bundle an original portable skill creator and an optional host-approved, revision-checked
  SKILL.md-only save contract; hosts retain disk roots, approvals, atomic persistence and lifecycle
- Cover bounded YAML, interoperability, lazy resources, stale/readonly/cancelled saves and packed
  ESM/CommonJS declarations; use maintained `yaml@2.9.1` (ISC) only in the optional skills module
- Prepare the additive stable release. No desktop/CLI adoption, executable plugins or publication included

## 0.5.0 (2026-10-06)

- Extract an optional shared bounded v1 memory service, codec, revision/context helpers and
  static tool pack behind mandatory host-policy callbacks
- Preserve legacy stored records and revision bytes, queued stale checks, cancellation and
  commit-boundary semantics; keep atomic persistence, recovery, approvals and lifecycle in hosts
- Add mock memory regressions and packed ESM/CommonJS/declaration coverage. No host adoption
  or CLI session-note migration is included
- Publish the exact reviewed archive; registry bytes, all 138 installed files, ESM/CommonJS
  runtime and strict NodeNext declarations are verified. Host adoption remains separate

## 0.4.0 (2026-10-05)

- Add the optional pure `providers/models` subpath for versioned, exact-ID, endpoint-aware model
  capability normalization; keep the root, provider transports, and agent loop unchanged
- Preserve supported/unsupported/unknown states for chat, tools, streaming, reasoning, named
  effort selection, and explicit disable, independently of mandatory reasoning and defaults
- Include officially reviewed seed facts and conservative gateway metadata interpretation, paired
  CLI/desktop fixtures, and real packed ESM/CommonJS runtime and NodeNext declaration checks
- Keep host fetching/cache, credentials, choices, defaults, moderation, UI, and routing policy
  outside core. Published `0.3.0` bytes are unchanged; consumer adoption requires verified `0.4.0`
  registry bytes and separate host changes that preserve existing capability coverage

## 0.3.0 (2026-10-05)

- Add optional cache-read/write input token counts to provider results, round events, and agent
  aggregates; omit each aggregate cache count unless every accepted round reports it
- Parse OpenAI Responses and OpenRouter Chat cache usage in streaming and nonstreaming responses,
  preserving explicit zero without changing caching configuration or request defaults
- Add optional trusted in-process tool extension registration, fixed per-turn definitions and
  executable snapshots, argument validation, collision checks, and ordinary tool error results
- Add a shared bounded calculator pack for CLI and desktop reuse, preserving the CLI tool name
  and result shape; keep approvals, storage, credentials, and resource ownership in each host
- Verify ESM/CommonJS core, provider, and extension exports and declarations in clean packed
  consumers


## 0.2.1 (published)

- Add opt-in `requireSupportedParameters` to the OpenRouter adapter, mapping to
  `provider.require_parameters: true` so hosts can require endpoint support for supplied parameters
- Preserve default OpenRouter routing unless the new option is enabled
- Omit tool fields in both adapters when no tools are supplied; use OpenRouter's automatic tool
  choice default without requiring the optional `tool_choice` capability
- Validate the routing option before requests and retain existing timeout, cancellation and
  sanitized-error behavior; verify mock streaming/nonstreaming requests and packaged consumers

## 0.2.0 (2026-10-04)

- Add provider-neutral OpenAI Responses and OpenRouter Chat Completions factories with
  injectable HTTP transport, sanitized failures, finite end-to-end timeouts and no automatic retries
- Add ordered display-only streaming progress; incomplete or failed output never dispatches tools
  or enters accepted history
- Preserve provider/model-scoped native reasoning continuity for validated tool-result exchanges
- Export canonical-history validation and interrupted-history recovery without replaying tools
- Reject overdue results after synchronous provider work and release progress waits when a round
  fails, preserving cancellation and event-error behavior
- Ship ESM and CommonJS entry points and TypeScript declarations for the core and both adapters
- Keep application policy, approvals, credentials, storage and UI host-owned; zero runtime dependencies

The reviewed implementation is merged on vivi main at
`063b84a009d8cc9c553f508e8d3cfece59fe0b1a`. Release preparation changed version metadata
and documentation only. The public npm archive was verified byte-for-byte against the reviewed
artifact; see [RELEASING.md](RELEASING.md) for its immutable hash record.

## 0.1.0

Initial Apache-2.0 provider-neutral agent core, published to npm. This immutable release does
not include the shared provider factories, streaming progress or history helpers above.
