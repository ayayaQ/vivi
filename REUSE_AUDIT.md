# Shared-use audit

This audit covers the desktop agent loop, provider adapter, tool executor, history, memory,
documentation policy, session service and renderer boundary. Published stable `0.3.0`
has two real hosts: desktop and CLI. Shared components are kept small and provider/domain neutral.

## Extracted

- Core loop: canonical messages, sequential complete tool execution, usage accounting, bounded
  rounds, cancellation, immutable events and complete returned transcripts
- Provider adapters: HTTP configuration/timeouts, safe error reporting, completed-output parsing,
  native provider/model continuation, history projection and spec-framed streaming
- Canonical-history validation: the core and hosts can enforce the same ordered, unique tool-call
  exchange without running a provider
- Crash recovery: both hosts close missing results with unknown-outcome errors, never replaying
  historical calls or restoring an old approval as new permission
- Display-only progress contract: both hosts consume text deltas without committing partial
  assistant text or dispatching incomplete calls

The root entry point remains free of provider transport, filesystem, terminal and app imports.
Provider-specific entry points stay in the shared library package. The CLI is a separate simple
project, consuming the exact shared-library npm release. It does not copy the
loop or provider protocol. The core loop has no runtime dependency imports; the published `0.6.0`
optional instruction-only skills module separately loads maintained YAML for standard frontmatter.

## Optional skills foundation (published 0.6.0)

The shared SKILL.md format/parser, bounded immutable turn catalog, list/read tools, original
creator and optional narrowly scoped save contract are provider/domain-neutral. Hosts explicitly
choose sources and retain app-wide filesystem stores, scanning/resource containment, approvals,
revision-checked atomic writes, operation admission/drain and future-turn activation. Neither
desktop nor CLI adoption is included. This is an instruction-only module, not a plugin runtime
or security boundary. See [the interoperability and host contract](docs/SKILLS.md).

## Optional decisions foundation (published 0.7.0)

The optional `@ayayaq/vivi/decisions` subpath supplies bounded frozen exact-action snapshots,
host-authored predicate checks, explicit provider-specific thresholds and fail-closed
recommendations through dedicated OpenAI Decisions and OpenRouter Jev transports. It is
published in verified stable `0.7.0` and absent from immutable `0.6.0`. Exact registry bytes
and clean consumers are verified; host adoption remains separate. Hard policy, eligibility, privacy,
manual review UI, resource locking/revision rechecks, execution and audit storage remain
host-owned. Mock protocol/safety tests establish implementation behavior, not real-model
accuracy or threshold calibration. See [the decision contract](docs/DECISIONS.md).

## Optional MCP foundation (prepared 0.9.0)

The CLI-demonstrated bounded catalogs, alias mapping, schema quarantine, immutable
operation bindings, fixed extension and result projection are reusable without the
CLI's SDK, filesystem or process imports. A host-supplied compiler enforces the accepted
schema subset; this does not add a generic schema engine to the main agent loop.
Connections, configuration/credential policy, human approval, actual transport-boundary
checks, cancellation, unknown-outcome handling and app history remain host-owned.
Adapter tests prove the contract against both host shapes without adopting unpublished
versions. See [the precise boundary](docs/MCP.md).

## Reviewed and kept host-owned

- Tool argument validation: core checks the JSON envelope; calculator/notes and bot resources
  need different semantic constraints. A generic schema engine would add weight without replacing
  either host's domain checks. Advertising a tool never authorizes it
- Structured results and result limits: core-generated failures already share a stable JSON error
  shape. Desktop truncation and documentation quotas are application-specific; bounded CLI tools
  produce small results. No common result-truncation policy is imposed
- Context selection/compaction: tool groups must stay paired, and native continuation must remain
  consistent. Neither host had a duplicated general compactor to extract. The CLI enforces bounds
  rather than silently dropping history; hosts choose future summarization policy
- Sessions and persistence: CLI files and Electron's app session store have different ownership,
  versioning, migration, locking and consistency boundaries. Only process-neutral recovery is shared
- Approvals/revisions: desktop manual/auto/planning modes and resource transactions stay in the
  desktop host; opt-in notes use their own explicit approval and revision check
- Memory and documentation: desktop memory policy, search budgeting, bot documentation and prompts
  remain domain-specific
- Moderation/model selection: app moderation requirements, settings, model capabilities and
  attribution stay in the host. The published `0.4.0` optional `providers/models` subpath shares only
  pure documented capability interpretation and exact endpoint-aware identities, with unknown
  facts preserved. Catalog fetching/cache, account visibility, model choices, defaults, routing,
  legacy-setting migration and moderation remain host-owned. Shared OpenRouter configuration
  requires only its own credential
- UI/IPC: terminal rendering and Electron/Svelte events have separate host lifecycles. They reuse
  the progress contract, not a common UI framework

## Published extension foundation

The `0.3.0` optional `extensions` subpath shares only trusted tool definitions, explicit
argument validators and executors. One registry captures frozen definitions and fixed callbacks
for one turn; registration rejects collisions with all reserved host tools. There is no loader,
marketplace, installer, filesystem discovery, permission broker, lifecycle-hook system or sandbox.
The bounded calculator parser is extracted from the Apache-2.0 CLI (see `ATTRIBUTION.md`).

Local consumer proofs replace the CLI's calculator implementation with that shared pack and
append the same pack to desktop agent runs. The CLI captures registration before persistence;
desktop executes inside its existing runTool lifecycle and reserves all built-in names, including
disabled mutation tools. Desktop MCP/domain tool definitions are unchanged. Host approvals,
redaction, result bounds, persistence and resources remain host-owned.

The extension prototypes proved the shared seam before `0.3.0` was published and both hosts
integrated its verified registry bytes. The later capability module needs the same separate
publication and host-adoption gate; a temporary local pack does not establish registry adoption.

## Verification boundary

Tests exercise fake HTTP for both provider protocols, native tool-result continuation, fragmented
streams, failures, cancellation and deadlines. Core/host tests cover approvals, revisions,
checkpoint recovery and final transcript reconciliation. Packaging tests install a real archive
and check ESM/CommonJS libraries and TypeScript declarations. The separate CLI validates its
installed executable and dependency packaging.
No test requires a live model, credentials, a user computer or GUI automation.

The desktop app's GPLv3 license is unchanged. vivi's shared extraction and generic CLI remain
Apache-2.0 under the copyright owner's authorization. Development artifacts do not alter or replace
the published `0.1.0` release.
