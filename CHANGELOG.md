# Changelog

## 0.2.1 (unreleased)

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
