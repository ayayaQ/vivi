<a id="tool-image-observations-unreleased"></a>

# Tool image observations (available in 0.16.0)

Available in published `0.16.0` and `0.17.0`. Host snapshot storage, permissions and
image-capable UI adoption remain separate integration decisions.

Images are optional tool-result data, not a new attachment command. Core never reads
paths or grants file access. A host may expose `read_image({path})` under its existing
workspace/file approval rules; mentioning a path alone does not read or upload it.

`ToolResult` and canonical `ToolResultMessage` accept `images?: readonly ToolImageReference[]`:

```ts
{ id: 'host-snapshot-id', sha256: 'lowercase hex SHA-256', mimeType: 'image/png',
  width: 1024, height: 768, byteLength: 12345 }
```

Only PNG/JPEG, 1–4 exact references/result, 5 MiB/reference and 16 million pixels/reference
are accepted (`TOOL_IMAGE_LIMITS`). IDs are opaque bounded identifiers, never paths or URLs.
Host-owned immutable bytes must be stored before canonical acceptance. Preserve snapshots
for durable replay; never reopen the original path as though it were the same observation.
A changed file requires a new tool observation. There is no automatic workspace scanning,
remote fetching, `/attach`, clipboard handling, or permission bypass in core.

Pass synchronous `resolveImage(reference): Uint8Array` to a provider adapter. Core verifies
snapshot length, SHA-256, actual PNG/JPEG header MIME and dimensions before encoding.
A missing resolver/snapshot, corrupt metadata or unknown/unsupported vision capability is
an explicit dispatch error, never a text-only fallback. Hosts own cancellation-aware loading,
credentials, snapshot persistence and bounded caching. Adapter projection allows at most
32 images and 64 MiB of referenced bytes per dispatched request.

Vision **and** tools must be supported by the exact model. Adapters accept an exact-bound
`modelCapabilities` snapshot; the bounded reviewed registry can supply known OpenAI facts.
Provider/catalog input modalities supply other model facts. Unknown is not supported.

OpenAI Responses projects native image parts inside the original `function_call_output`.
OpenRouter and DeepSeek retain every real tool result contiguously, followed by a derived
provider-only user image observation linked to its original call IDs and explicitly labelled
untrusted tool data, not a new user request/instruction/approval. That companion is never
canonical history, steering or an accepted user turn. This conservative normalization does
not depend on disputed native tool-image support across backing chat endpoints.

Estimation uses the same structural projection with metadata-only placeholders, never
resolving snapshots or charging base64 characters as text. A conservative dimension-aware
visual allowance is added; it is not an exact provider tokenizer count. Generation resolves
only the final prepared view, so old images can compact away before loading. Compaction
retains recent whole tool groups and serializes older image identities/metadata as summary
source, not pixels. Summary instructions forbid inventing visual facts from metadata. Covered image IDs and
metadata are retained in a deterministic checkpoint-summary appendix even if the model
omits them. Canonical references remain unchanged.

Durable `/events` and `/events/stream` envelopes accept explicit **version 2** image records.
Version 1 remains text-only and rejects images; existing text-only callers remain valid.
Image-capable hosts must coordinate their own session schema and dependency adoption,
and retain snapshot access alongside journal replay. Neither journal references nor image
contents authorize actions. No provider was live-qualified as part of these offline changes.
