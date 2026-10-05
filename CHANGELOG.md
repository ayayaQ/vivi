# Changelog

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
