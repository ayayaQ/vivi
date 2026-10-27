# Provider-facing context management

Available in published `0.14.0`. Production host adoption requires verified public registry bytes.

The root `@ayayaq/vivi` export offers optional request measurement and portable compaction.
It does not replace canonical history, authorize tools, or change host storage limits.
Existing hosts without `RunAgentOptions.context` retain their original loop behavior.

## Three distinct records

- Canonical `messages` and `AgentResult.history` contain the complete original conversation,
  including accepted calls and actual outcomes. Keep them durably stored. Compaction never
  edits or deletes them. Existing approval, receipt and event-record checks remain authoritative
- `ContextCheckpoint` is a versioned derived summary, bound to a host `sourceId`, covered
  non-system message count and SHA-256 revision of that exact raw prefix and its current host-projected content. Store it separately
  from canonical history. A checkpoint with a different identity, edited/missing prefix, changed host content projection or an
  incomplete tool-group boundary is ignored; an invalid structure is rejected
- The effective provider request contains fresh host context, current instructions, an explicitly
  untrusted user-role summary and the recent complete conversation. Summaries cannot supply
  approvals or establish that side effects succeeded. Hosts must validate actual evidence

A missing `AgentResult.checkpoint` means no checkpoint update; it never instructs the host to delete a separately saved prior checkpoint.
A checkpoint alone cannot restore a session. Full raw source is required to verify its binding.
The source digest intentionally excludes system messages, so fresh instructions do not invalidate
an otherwise unchanged historical source. Preserve all current system messages; do not put stale
historical instructions into that channel.

## Minimal host integration

```ts
import { runAgent, measureContext, compactContext } from '@ayayaq/vivi'

const context = {
  sourceId: session.id,
  checkpoint: session.contextCheckpoint,
  prefixMessages: freshHostContext, // complete ephemeral messages, including current instructions
  limits: {
    contextWindow: selectedModel.contextWindow,
    maxOutputTokens: selectedModel.maxOutputTokens,
    source: selectedModel.contextLimitsSource
  },
  onCheckpoint: async checkpoint => saveSeparateCheckpointAtomically(checkpoint)
}
const next = measureContext({ provider, messages: session.history, tools, context })
const result = await runAgent({ provider, messages: session.history, tools, context,
  executeTool, onAccepted: commitCanonicalAcceptance, onEvent: displayProgress })
```

Omit unknown optional fields rather than setting them to `undefined` or guessing a model size.
`validateContextCheckpoint(value)` is a structural assertion; `measureContext` and preparation
add the exact-source binding check. Use a stable session identity, not a model ID.

`measureContext(input)` is pure: no network, event callback, summary, storage write, tool execution
or capacity enforcement. It returns a projected request, its occupancy, and `canCompact` eligibility for a new complete older prefix. Use it at idle/startup,
on a model switch, and after a completed run if the UI wants a next-request estimate.
`prepareContext(input)` performs threshold compaction when enabled and enforces known capacity
before dispatch. `compactContext(input)` is the manual path and returns the same shape. These
functions never execute tools. Manual compaction should use the host's normal exclusive run
owner and cancellation handling so it cannot race a send or session switch.

`onCheckpoint` is awaited before a new view is returned or dispatched. Hosts own atomic writes,
privacy checks, serialized storage ordering, and recovery. A failed checkpoint write prevents
normal dispatch with the new view. A crash with no saved checkpoint resumes from canonical
history; a saved checkpoint is revalidated. Cancellation quarantines a late summary and blocks
late dispatch; hosts should also bound their own persistence callbacks.

## Measurement and limits

`ContextUsage.inputTokens` describes the entire effective request. It is unrelated to cumulative
billing `Usage`. For compatibility, `AgentResult.usage` sums known counts from reported accepted
rounds; if any round omitted usage, that required aggregate alone is not a complete billing measurement. A provider's `estimateContext(input, {maxOutputTokens})` must use the same
projection as `generate`, including tool schemas, fresh prefixes and native continuation state.
Built-in adapters estimate their provider-projected prompt surfaces. The fallback estimates the
serialized supplied history and schemas with UTF-8 bytes plus message overhead. Both heuristics
are marked `estimated: true`; neither promises a tokenizer or exact provider occupancy.

Capacity normalization uses explicit provider catalog data or documented exact IDs, never a
model-name guess. `contextWindow` is the combined model window. `maxInputTokens` is a distinct
endpoint prompt cap. `maxOutputTokens` is the documented output ceiling. Unknown values remain
omitted; catalog metadata does not prove account access or every routed endpoint's capacity.
The available input budget is the minimum known endpoint cap and model window minus reserved
output. Limit source metadata, including host-supplied freshness, flows to `usage.limitSource`.

An explicit host `reserveOutputTokens` wins; otherwise a provider's optional
`defaultOutputTokens` recommendation is used. Providers without a recommendation
retain the smaller of 4,096 tokens and 10% of a known model window (4,096 for an
unknown window). Every choice is capped by a known `maxOutputTokens` ceiling.
The same reserve is counted against input capacity and sent as the request output
bound; an input that cannot fit is compacted or rejected, never silently dispatched
with an unreserved larger limit. Hosts wrapping a provider must forward its
`defaultOutputTokens` and both `estimateContext` arguments. Changing provider or
reasoning mode requires measuring again with the new provider instance.

Summaries use at most the selected output reserve and the provider recommendation,
or 2,048 tokens for providers without one. This leaves room for reasoning even
when the requested summary text is concise. Explicit smaller host bounds still
apply. Larger allowances can increase latency and cost; there is no automatic
retry for incomplete output.

Unknown capacity still yields an estimated numerator, with no fabricated denominator or
utilization percentage. It disables threshold-based compaction; manual compaction and classified
overflow recovery remain available. Missing provider usage is unreported, never measured zero.
`AgentResult.contextUsage` is the last prepared request snapshot; remeasure after new accepted
history to display prospective occupancy.

## Compaction boundaries and failures

The default threshold is 85% of available input. Before each provider request, the loop may
summarize older history using the same selected provider/model, tools disabled and an explicit
`purpose: 'context-summary'` metadata flag. Guarded hosts should still privacy-screen it, but
must skip canonical assistant-acceptance/receipt/round-usage preflight. The flag is never sent
as a provider API parameter. Summarizer requests contain portable conversation data and the
previous summary when present; opaque native reasoning remains in raw storage and retained
recent groups, rather than being copied into the summary prompt.

The latest user message is kept exactly. At least the newest six canonical messages remain
verbatim by default (`keepRecentMessages`), expanding the cutoff to keep each assistant tool-call
and all of its results together. All current instructions, fresh `prefixMessages` and tool schemas
are kept. Hosts may supply a pure `projectMessages` content-only transformation to expire skill
guidance in both provider views and summary source; it must retain every message and protocol
identity. It cannot rewrite canonical evidence.

A summary must reduce the measured complete request and fit known limits before publication.
Repeating manual compaction with no new eligible older prefix is a successful no-op, with
no summary request. Overflow recovery still requires a strictly smaller request. A measured
irreducible retained floor is checked before paying for a summary.
No eligible older group during required reduction, a summary source that cannot fit, failure to shrink, invalid output,
checkpoint failure, and persistent over-limit prefixes/tools/recent groups stop with actionable
errors. There is no silent tail truncation, speculative tool execution, background summarization,
provider-native opaque compaction, vector retrieval or hierarchical compaction in this baseline.

Host-only `reservedToolCallIds` metadata carries all canonical call IDs to built-in adapters,
including IDs hidden by compaction. This preserves existing plain OpenRouter turn-local ID
normalization without changing opaque native reasoning identities or putting historical IDs
into the prompt. Provider wrappers must forward this metadata unchanged.

Only a sanitized structured `context_overflow` classification permits one smaller-request retry.
An arbitrary error string, authentication failure, rate limit, or incomplete generation cannot
trigger recovery. The rejected request has accepted no assistant/tool effects; completed effects
from earlier rounds are never repeated. A second overflow stops with `context_cannot_fit`.

Lifecycle events are `context_usage`, `compaction_started`, `compaction_usage`,
`compaction_completed`, and `compaction_failed`. Summary usage is separate from accepted-round
usage and is emitted before shrink/storage checks, so even an unsuccessful compaction can expose
its known cost. A missing `compaction_usage.usage` is unknown. Events contain no summary text or
raw provider errors. Persist summaries only through the separate checkpoint path, never canonical
acceptance events. `createRunSettlement` excludes derived checkpoint/occupancy metadata.

Raw history and canonical event journals continue to grow. This feature does not solve a host's
active-history shadow, session byte/message cap, raw journal cap, or archival policy.

## Design references

Reviewed 2026-10-15; independently implemented, with no copied source code:

- [pi compaction reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md):
  separate persisted compaction entries and provider views, recent complete groups, iterative
  summaries, safe boundaries, and summary usage informed the portable baseline
- [DeepSeek token meter](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/token-meter/README.md):
  separate projected request occupancy, heuristic uncertainty, route-owned capacity and billing
- [DeepSeek basic compaction](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/README.md):
  explicit capacity/output reserve, manual/automatic/overflow paths and indivisible-unit limits

The existing CORE-14 hierarchical experiment remains offline and is not this implementation.

## Fresh dispatch prefixes (unreleased)

`runAgent({ getContextPrefix({signal}) { return messages } })` optionally pulls fresh
ordinary canonical `Message` shapes (`kind: 'message'`, `role: 'system' | 'user'`, string
`content`) once before each response dispatch, including the single overflow retry.
The callback may be async and is cancellation-aware even if its promise does not settle.
It runs before measurement/compaction; that exact detached prefix is then measured and
used for the ensuing dispatch/tool batch. The host owns instruction scope/revisions;
core does not scan files or hot-reload a currently executing batch.

Static `context.prefixMessages` precede this dynamic prefix. Without context management,
the dynamic prefix directly precedes canonical history. Both are provider-only: they never
enter accepted updates, canonical history, steering, summary source or checkpoint identity.
A derived user-role prefix is lower-trust context, not a new user request or approval.
Hosts should frame raw project documents as quoted untrusted data under trusted system
instructions. Assistant/tool-result shapes and extra fields are rejected. Invalid data is
`invalid_input`; callback failure is `context_error` without dispatch; abort is `cancelled`.
Omitting the option preserves existing behavior.
