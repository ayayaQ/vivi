# vivi

A small, headless TypeScript tool-calling loop. `@ayayaq/vivi` has no runtime dependencies and
requires Node.js 22 or newer. It supports ESM and CommonJS. It knows about messages, providers, and tool calls;
your host owns the application, network access, approvals, and storage.

## Install

The published `@ayayaq/vivi@0.2.0` includes the core, shared OpenAI/OpenRouter provider
factories, streaming progress, canonical-history helpers and deadline fixes:

```sh
npm install --save-exact @ayayaq/vivi@0.2.0
```

The public registry archive was verified byte-for-byte against the reviewed release. See
[CHANGELOG.md](CHANGELOG.md) for changes and [RELEASING.md](RELEASING.md) for its immutable
archive hashes and release workflow. The earlier `0.1.0` release contains the core only.

Build and verify the source checkout locally:

```sh
npm ci
npm run check
```

The package contains ESM and CommonJS libraries, declarations and source. Installing it does
not run build scripts. Core and adapters have zero runtime dependencies; TypeScript is the
sole development dependency. Tests use fake providers/HTTP and the built-in Node test runner,
never model credentials. `npm pack` produces a local test archive; do not commit pack outputs
or substitute new bytes for an already published version.

## Small host integration

```ts
import { runAgent, type ModelProvider } from '@ayayaq/vivi'

const provider: ModelProvider = {
  async generate({ messages }, signal) {
    signal.throwIfAborted()
    // A real adapter translates the canonical history to its provider's native format.
    const stock = messages.find(message => message.kind === 'tool_result')
    return stock
      ? { content: `Stock: ${stock.content}`, toolCalls: [] }
      : { content: '', toolCalls: [{ id: 'stock-1', name: 'stock', arguments: {} }] }
  }
}

const result = await runAgent({
  provider,
  messages: [{ kind: 'message', role: 'user', content: 'Check stock' }],
  tools: [{ name: 'stock', description: 'Read stock', parameters: { type: 'object' } }],
  async executeTool(call, { signal }) {
    signal.throwIfAborted()
    return { content: '12' }
  },
  onEvent(event) { console.log(event.type) }
})

console.log(result.status, result.content)
```

The independent [inventory example](examples/inventory.mjs) also demonstrates host-owned mutation
denial and revision checking. It runs entirely locally with a fake provider.

## Trusted tool extensions (unreleased)

The optional `@ayayaq/vivi/extensions` subpath registers explicitly imported, trusted in-process
code. It adds no loader, installation flow, permissions, sandbox, UI, or runtime dependencies.
The core runner is unchanged. This API is under review in `0.3.0-dev.0`; it is not in the
published `0.2.1` package.

```ts
import { runAgent } from '@ayayaq/vivi'
import { createToolRegistry } from '@ayayaq/vivi/extensions'
import { calculatorExtension } from '@ayayaq/vivi/extensions/calculator'

// Build once per turn; reserve every host tool name, including temporarily disabled tools.
const registry = createToolRegistry([calculatorExtension], { reservedNames: ['host_tool'] })
const result = await runAgent({
  provider, messages, tools: registry.tools, executeTool: registry.executeTool
})
```

A `ToolExtension` has an `id`, `apiVersion: 1`, and `tools`. Each tool contains a normal
`definition`, a synchronous `validateArguments(arguments)` assertion, and
`execute(call, { signal })`, returning a `ToolResult` or promise. Callbacks are invoked without
`this`; capture any trusted dependencies explicitly. The calculator pack contains the bounded
`calculate` tool, accepting `{ expression: string }` and returning `{"result": number}`.

- Registration throws for malformed contracts, unsupported API versions, duplicate extension IDs,
  duplicate tool names, or reserved host-name collisions
- The registry captures validator/executor references and deeply copies/freezes definitions.
  Later edits to source objects cannot change that snapshot. Pair its advertised tools and
  executor for the entire turn; create another registry between turns to change registration
- Calls and arguments are cloned/frozen once before validation and execution. Invalid arguments
  return `isError: true` with JSON error code `invalid_arguments`; missing tools return
  `unavailable_tool`; execution failures or invalid results return `tool_error`. Malformed call
  envelopes and contexts throw before callbacks. Schemas describe arguments; validators enforce them
- The same signal reaches execution. Abort before validation, before execution, or before accepting
  a result throws the signal's reason. `runAgent` supplies prompt cancellation even if an async
  executor ignores abort; direct registry calls must cooperate to settle promptly. In-process code
  cannot be forcibly stopped or have side effects undone
- There are no activation/disposal hooks or managed resources. The host owns registry lifetime,
  approvals, credentials, redaction, persistence, and any captured resources. Registry checks are
  correctness checks, not security isolation. Tool errors may include thrown messages

See [the registry tests](test/extensions.test.mjs) for snapshot and cancellation behavior.

## Contracts

- `ToolDefinition`: `{ name, description, parameters: JsonObject }`
- `ToolCall`: `{ id, name, arguments: JsonObject }`
- `HistoryMessage`: a user/system `message`, an `assistant` with `content` and `toolCalls`, or a
  `tool_result` with `callId`, `name`, `content`, and optional `isError`
- `ModelProvider.generate({ messages, tools }, signal)`: returns `{ content, toolCalls }` with optional
  `usage: { inputTokens, outputTokens, totalTokens }` and `providerState`
- `runAgent({ provider, messages, tools, executeTool, signal?, maxRounds?, onEvent? })`: returns
  `{ status, history, content, rounds, usage, error? }`

See the [exported types](src/types.ts) for the complete API. The result status is `completed`,
`cancelled`, or `error`. Errors have `code` and `message`. `rounds` counts accepted provider
responses, including a final text-only response. Usage sums accepted responses; omitted usage
adds zero. Counts must be nonnegative safe integers. Provider total counts are preserved even
when they differ from input plus output counts. `content` is the latest accepted assistant text,
including empty text. The result's history includes the initial messages.

`maxRounds` defaults to 25 and must be an integer from 1 to 1000. A final response must fit within
that limit. Reaching the limit after a tool round returns an error with code `max_rounds`; tools
from that accepted round are resolved first.

Messages and tool schemas are JSON-compatible plain data. Numbers must be finite; cycles,
undefined, sparse arrays, functions, symbols, accessors, and class instances are rejected. Optional
JSON fields should be omitted, rather than set to undefined. Core validates envelope shapes and
call identity, not JSON Schema or application argument semantics. `validateHistory(value)` makes the
same canonical-history checks available without a model request; it throws on malformed or
incomplete history. The host must validate arguments
against its schemas and domain constraints before acting.

Advertising a tool enables dispatch; it does not authorize an action. Core is not an approval
system or security sandbox. The host must enforce authorization, approval, data-sharing boundaries,
and any isolation required by its tools.

## Transcript and provider adapters

The loop copies caller history and tool definitions. It stores each accepted assistant message
before executing any of its tools, then runs those tools sequentially and appends one matching
result per call. Tool IDs must be nonempty trimmed strings and globally unique within the supplied
history and this run. Supplied history must already contain a complete, ordered set of tool
results for every assistant tool-call group. Malformed history returns `invalid_input` without
starting the provider.

Malformed provider output, including duplicate IDs or invalid JSON arguments, returns
`invalid_provider_output` before committing that response or executing tools. A well-formed call
to an unadvertised name gets a matched, model-visible JSON failure with error code `unavailable_tool`;
the host executor is never called for it. Host executor exceptions and malformed tool outputs
become tool results with error code `tool_error`, allowing the model to respond. Other provider
failures end the run with `provider_error`. Core-generated failure content has the shape
`{ "success": false, "error": { "code": "...", "message": "..." } }` and `isError: true`.
Tool exception messages are visible to the model; hosts should sanitize private details first.

An assistant can carry `providerState: { provider: string, items: JsonValue[] }`. Core preserves
this opaque JSON in history. It does not interpret or merge native reasoning/assistant items.
The matching adapter must replay its native items correctly, avoid double-inserting canonical
text/calls, and ignore states belonging to other adapters. Switching adapters may lose native
reasoning continuity and is a host decision. Provider-specific HTTP and wire formats belong in optional adapter subpaths. Importing the root
entry point does not import a provider transport or CLI.

## Events, errors, and cancellation

`onEvent` is optional, ordered, and awaited. Completed-round events are:

1. `assistant` with the accepted `message`
2. `tool_started` with a `call`
3. `tool_completed` with the matching result `message`, repeated sequentially per call
4. `round_completed` with that response's optional `usage`

Providers, tool executors, and event hooks receive deeply frozen snapshots. They cannot mutate
caller inputs or the live transcript. Event hooks may persist their snapshots or update UI. A
throwing hook ends the run with `event_error`; no subsequent hook is invoked. Synthetic cleanup
results are added to the returned transcript for any accepted pending calls, so it can safely be
used on the next turn. Reconcile the final returned history when persisting: the event stream
alone can be incomplete after cancellation or a hook failure.

The caller's abort reaches providers and tools. Each provider round also has a derived signal so a failed
progress hook can terminate its transport. Aborting ends an outstanding provider, tool,
approval, or hook wait promptly even if the host promise never settles. Core starts no further
work or events after it observes the abort and ignores late settlements. Every accepted pending
call receives a `cancelled` tool result in the returned transcript. Cancellation is a terminal
status, not a tool failure the model should retry. Cleanup after another run-ending failure uses
`run_failed` results.

Cancellation cannot roll back side effects or stop an already-running uncooperative host callback.
The host must observe the signal, remove pending approval state/listeners, check cancellation
again after any approval or I/O wait, and check current resource revisions immediately before a
mutation. Never commit a delayed approval after cancellation. Event callbacks should also avoid
late writes once their signal/session has become stale. Keep persistence and approval transactions
inside the host's own consistency boundary.

## Shared provider factories

```ts
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
import { createOpenRouterProvider } from '@ayayaq/vivi/providers/openrouter'

const provider = createOpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'your-model-id',
  reasoning: { mode: 'default' },
  timeoutMs: 60_000,
  stream: true
})
```

Both factories implement the same `ModelProvider` contract. OpenAI uses Responses; OpenRouter
uses Chat Completions. Configuration contains a model, a key (or async key supplier), optional
reasoning, request timeout, streaming flag and injectable fetch. OpenRouter can receive optional
host attribution; no Discord branding, desktop settings or moderation key is built in.

Reasoning has three explicit modes: `default` omits the provider setting, `disabled` requests
reasoning off, and `effort` supplies a named effort. Nondefault choices require the host to declare
`supportedReasoningEfforts` for its selected model; include `none` only when disabling is supported.
This is a host capability assertion, not automatic model discovery. Changing provider or model
can discard native reasoning continuity; the CLI requires a new session for such a change.
OpenRouter retains returned reasoning state for tool continuation while displaying only answer text.

For OpenRouter, `requireSupportedParameters: true` (added in the planned `0.2.1` release) sends
`provider.require_parameters: true`, restricting routing to endpoints that support every supplied
parameter. Use it when the host relies on declared tool or reasoning capabilities. The option
defaults to false and is omitted from the request unless enabled, preserving OpenRouter's default
routing. It does not discover capabilities or guarantee endpoint availability; a request with no
eligible endpoint can fail normally. See [OpenRouter's routing documentation](https://openrouter.ai/docs/guides/routing/provider-selection#requiring-providers-to-support-all-parameters).

Both adapters omit tool parameters when the host supplies no tools. OpenRouter also omits the
redundant `tool_choice: 'auto'` when tools are present, using its documented automatic default.
This allows strict routing to endpoints that support tools without requiring separate
`tool_choice` support. See [OpenRouter's tool choice documentation](https://openrouter.ai/docs/guides/features/tool-calling#tool-choice-configuration).
OpenAI retains automatic tool choice when tools are present.

HTTP/provider failures are sanitized and never include raw response bodies. Requests have an
explicit finite end-to-end timeout, covering credential resolution, request preparation, body
reading, parsing, and awaited progress hooks. Synchronous JavaScript cannot be interrupted;
elapsed time is checked at boundaries to reject overdue results and suppress later HTTP requests,
progress, and tool calls as soon as that work returns. There are no automatic retries.
Hosts decide whether a new turn is appropriate;
never replay a mutation because a response or stream failed. Native state is tagged by exact
provider/model, validated, and replayed only when consistent with canonical messages.

With streaming enabled, adapters accumulate complete validated responses before returning any
tool call. `generate(input, signal, { onProgress })` can send ordered `text_delta` progress and
`runAgent` exposes it through `onEvent`. Partial text is display-only, absent from history and
usage until a response is accepted. Interrupted/failed streams commit no partial call. Hosts clear
partial display at an accepted assistant or terminal result. Late callbacks are ignored; throwing
progress hooks end the run with `event_error` and cancel the provider round.

## Shared history recovery (0.2.0)

`closeInterruptedHistory(messages)` copies and validates persisted canonical history, then fills
missing trailing results with `interrupted` errors. Such a tool's outcome may be unknown: read
current state before retrying. Recovery does not execute any historical tool, even if a mutation
was approved before the crash. It preserves completed results and rejects orphaned, reordered,
duplicate or malformed tool exchanges. Hosts still own session versions, storage, bounds, legacy
migration and policy.

## Separate CLI reference host

The generic CLI is a separate project at [ayayaQ/vivi-cli](https://github.com/ayayaQ/vivi-cli),
using these exact adapters and core as a dependency. It is not included in this package and does
not copy the agent loop or provider protocol. The CLI registry transition pins shared vivi `0.2.0`. npm `0.1.0` does not contain the new
adapter/history exports needed by that CLI.

## Deliberately outside the core

The [shared-use audit](REUSE_AUDIT.md) records what was extracted and why the remaining
validation, context, policy, persistence and domain components stay in their hosts.

Domain prompts and tools, manual/automatic/planning modes, approval UI, revision-aware mutation
commits, persistence, memory policy, result truncation, model selection, credential acquisition, retry policy, compaction, routing, Electron, and any
application UI remain host concerns. Optional provider adapters perform only protocol translation
and bounded HTTP requests; the CLI is a separate reference host.

## License and origin

Apache License 2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE), and [ATTRIBUTION.md](ATTRIBUTION.md).
This extraction originates from Bot Commander Desktop at source commit
`943e3f84f67e4415a899da8921db84639843c625`. The copyright owner authorized this separate Apache
release; the upstream desktop application's GPLv3 license is unchanged.
