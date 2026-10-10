# Changelog

## Unreleased

- Add bounded opt-in terminal records and pure immutable full/incremental snapshot projections
  on `/events`; retain final reconciled history/usage, exact host outcome evidence and live callback compatibility
- Add an opt-in canonical accepted-update hook and bounded `/events/stream` run-local deltas,
  with exact session anchors, frozen replay, usage and terminal reconciliation
- Prove paired offline host append/checkpoint/recovery seams; production migration and
  sanitized bootstrap remain separately gated CORE-12/CLI-20/Desktop-14 work

- Add opt-in owned extension scopes with atomic registration, fixed lifetime-bound snapshots,
  combined cancellation and one awaited reverse-cleanup completion, including aggregate failures
- Cover late acquisitions, candidate rollback and owned CLI/Desktop listener/persistence adapters
  offline; host permissions, domain cleanup, MCP connections and durable outcome ledgers stay host-owned

## 0.9.0 (prepared 2026-10-09, not yet published)

- Add optional dependency-free MCP catalog, operation-binding, fixed extension and
  bounded untrusted-result helpers with mandatory host review/schema/privacy wiring
- Keep connections, processes, credentials, actual sends and approval UI host-owned;
  add a metadata-only host capability and offline paired-host adapter checks

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
