# Changelog

## 0.2.0 (prepared, awaiting npm publication)

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
`063b84a009d8cc9c553f508e8d3cfece59fe0b1a`. This release preparation changes version metadata
and documentation only. Registry availability and archive integrity must be verified separately.

## 0.1.0

Initial Apache-2.0 provider-neutral agent core, published to npm. This immutable release does
not include the shared provider factories, streaming progress or history helpers above.
