# DeepSeek model provider

The optional `@ayayaq/vivi/providers/deepseek` subpath implements the ordinary
`ModelProvider` interface using DeepSeek Chat Completions. It is independent of web
retrieval and approval-decision providers. Available since `0.15.0`; output-budget and diagnostic fixes are prepared for `0.15.1`.

```js
import { createDeepSeekProvider } from '@ayayaq/vivi/providers/deepseek'
import { normalizeModelCapabilities } from '@ayayaq/vivi/providers/models'

// Fetch/cache the /models catalog in your host, then retain the exact selected entry.
const capabilities = normalizeModelCapabilities({
  apiVersion: 1, provider: 'deepseek', protocol: 'chat-completions', model: selectedEntry
})
const provider = createDeepSeekProvider({
  model: selectedEntry.id,
  apiKey: () => host.requireDeepSeekApiKey(),
  stream: true,
  reasoning: { mode: 'default' }
})
```

The API root defaults to `https://api.deepseek.com`; the factory appends
`/chat/completions`. Credentials, selected models, catalog fetching/cache, capacity
policy, tool execution, approval policy, and storage stay with the host. Transport
injection, a custom API root, and end-to-end timeouts follow the other provider
factories. Requests are never automatically retried. No API key or network call is
needed to construct the provider, measure context, or run the offline tests.

## Capabilities and reasoning

Normalize each host-fetched `/models` entry through the existing models subpath.
DeepSeek uses `context_window`, `max_output_tokens`, modalities, and
`effort.supported_levels`. Limits remain unknown without valid catalog values; no
capacity is inferred from a model name. The documented exact IDs reviewed on
2026-10-18 are `deepseek-flash` and `deepseek-v4-pro`. This is not a frozen catalog or
a promise of account access. See [CAPABILITIES.md](../CAPABILITIES.md).

Default reasoning omits any override. DeepSeek currently enables thinking with high
effort by default. Explicit disable requires `supportedReasoningEfforts: ['none', ...]`
and sends `thinking: { type: 'disabled' }`. An explicit effort likewise requires the
host to supply its supported choices, and sends `reasoning_effort`. The adapter
accepts native `low`, `high`, `max` and documented compatibility aliases `minimal`,
`medium`, `xhigh`; it does not invent an `ultra` member in the shared effort contract.

## Output budget and incomplete responses

The provider advertises `defaultOutputTokens` using the documented endpoint defaults:
65,536 in default/enabled thinking mode, 131,072 with `max` effort, and 8,192 with
thinking disabled. Context management reserves and sends that allowance, clamped
by the host's model limits; an explicit host reserve overrides it. Without context
management or an explicit generation bound, the server still owns `max_tokens`.
These are output recommendations, not inferred model context limits. Larger
allowances include reasoning and can increase cost and latency.

JSON and streamed incomplete responses report the allowlisted finish reason:
`length`, `content_filter`, `insufficient_system_resource`, or `aborted`.
A `length` result can mean the output allowance or total context limit was reached;
it does not prove which one. Missing/unknown reasons remain generic and raw
upstream values are not echoed. Partial tool calls never execute or enter accepted
history, and incomplete output does not trigger automatic retries.

References reviewed 2026-10-21: [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)
and [model details](https://api-docs.deepseek.com/quick_start/pricing/).

## Native history and tools

Returned assistant state is labeled `deepseek:<exact selected model>` and contains
only a documented assistant message. Save that state with every accepted assistant
turn, including answers that made no tool calls. When a request has tools, DeepSeek
requires all previous assistant `reasoning_content`; dropping earlier text-only
turns' reasoning can cause a 400 response. The adapter preserves it and never
displays reasoning as answer progress. With no tools, prior reasoning is omitted
because the endpoint ignores it. The retained canonical state is unchanged.

State from another provider or model is never replayed, translated, or fabricated.
DeepSeek documents restrictions on synthetic mid-conversation tool-call insertion
through Chat Completions. Imported canonical assistant tool calls without compatible
native state are rejected before HTTP in every mode. With tools and enabled/default
thinking, every previous assistant turn must additionally have compatible native
string `reasoning_content`; otherwise generation and estimation reject the request.
Start a new session or use a portable summary before switching such histories.
No-tools portable text/summary requests remain supported. Explicitly disabled thinking
also permits portable text-only history with tools, but never imported tool calls.
Enabling thinking after turns that returned no native reasoning may therefore require
a fresh session or portable summary. A new thinking-with-tools tool-call response
lacking string native reasoning is rejected before canonical acceptance or tool
execution; an empty string actually returned by the API is retained unchanged.
Final text-only responses may omit reasoning; a later thinking-with-tools request
then needs a fresh session or portable summary.
The ordinary `compactContext` flow measures the normal request before summarizing,
so it cannot itself migrate history that already fails these projection rules.
A host migration flow must explicitly serialize the old conversation as quoted,
untrusted user data for a tool-free summary, then begin a new compatible view. A
previous checkpoint helps only when all retained assistant turns pass these rules.
`projectDeepSeekHistory(messages, model, { tools, thinking })` uses these same effective
request settings (default no tools, thinking enabled). Inconsistent native state from the same
DeepSeek/model fails with a sanitized configuration error rather than losing required
reasoning silently.

Tool results must match each pending call's exact ID and name in order. Unanswered,
duplicate, reordered, and unmatched groups are rejected before HTTP dispatch.
Returned IDs must be unique across history and any host-reserved canonical IDs;
they are never renamed. Function arguments must be a JSON object. Only complete
`stop` / `tool_calls` responses can be accepted; truncation, filtering, resource
failures, and interrupted streams cannot dispatch partial tool calls.

Streaming requires both a successful finish and `[DONE]`. Text deltas are ordered,
awaited display progress; reasoning and tool fragments remain internal until the
complete response is validated. Usage on the final content chunk is supported.

## Usage and context management

Input, output, and total tokens use the existing `Usage` contract. Cache hits map
from `prompt_cache_hit_tokens` or `prompt_tokens_details.cached_tokens` to
`cachedInputTokens`, already included in input usage. Cache misses are ordinary input
and never become cache writes. DeepSeek's miss counter and separate reasoning-token
breakout have no fields in the current shared `Usage` interface and are not exposed.
Reasoning tokens are already included in output usage and must not be added twice.
Missing/partial accounting remains unreported; explicit complete zeroes are preserved.
Usage is never inserted into native assistant history or context estimates.

`estimateContext` measures the same projected messages and schemas sent by normal
generation, including all retained reasoning when tools are present. It is a
conservative multilingual estimate, not a tokenizer or guaranteed upper bound.
`maxOutputTokens` is passed as `max_tokens`, covering reasoning and answer generation.
The host should derive its bounds from current catalog limits and remaining context.
Context-summary calls disable tools and use the requested output bound. Summary
requests are not canonical assistant turns or new tool receipts. The existing
classified-overflow mechanism accepts explicit machine-readable context errors;
error text or HTTP status alone does not trigger compaction.

## Host adoption and boundaries

A host needs an explicit `deepseek` chat-provider selection, separate DeepSeek
credential lookup, catalog normalization, factory dispatch, reasoning controls, and
native-state persistence. Web-provider selection is independent. Do not reuse an
OpenRouter factory with a changed URL or implicitly couple chat and retrieval.

This addition does not add a DeepSeek approval-decision provider. Hosts with binary
OpenAI/OpenRouter Auto-review assumptions must keep an explicitly configured supported
review provider or their existing manual-review path. Selecting DeepSeek for chat
does not authorize or select another service for review, and must never silently
route the user's actions through a different reviewer.

DeepSeek's Responses API has its own partial compatibility contract. This adapter
does not claim OpenAI Responses semantics, server-side stored conversations, or
support for arbitrary built-in tools. Image/file inputs are outside the core's
current text-only history contract even when a model catalog advertises them.

Official sources reviewed 2026-10-18:
- [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)
- [Model catalog](https://api-docs.deepseek.com/api/list-models/)
- [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [Tool calls](https://api-docs.deepseek.com/guides/tool_calls/)
- [Context caching](https://api-docs.deepseek.com/guides/kv_cache/)
- [Responses compatibility](https://api-docs.deepseek.com/guides/responses_api/)
