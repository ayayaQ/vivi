# vivi

A small, headless TypeScript tool-calling loop. `@ayayaq/vivi` has no runtime dependencies and
requires Node.js 22 or newer. It supports ESM and CommonJS. It knows about messages, providers, and tool calls;
your host owns the application, network access, approvals, and storage.

## Install and build

vivi is not published to the npm registry yet. `@ayayaq/vivi` is the configured package name for
its first release under the `ayayaq` account's scope. Use the local archive route below until a
registry release has been published and verified. Release preparation is documented in
[RELEASING.md](RELEASING.md).

Build and verify a local package from this repository:

```sh
git clone https://github.com/ayayaQ/vivi.git
cd vivi
npm ci
npm run check
npm pack
```

This creates `ayayaq-vivi-0.1.0.tgz`. From your own project, install that archive using its
relative path. For a project beside the `vivi` checkout:

```sh
npm install ../vivi/ayayaq-vivi-0.1.0.tgz
```

The archive contains built ESM and CommonJS, TypeScript declarations, and source. Installing it
does not run build scripts. Consumers can use `import { runAgent } from '@ayayaq/vivi'` or
`const { runAgent } = require('@ayayaq/vivi')`. CommonJS uses its own build and does not rely on
Node's newer `require(ESM)` interoperability.

`check` builds, runs fake-provider tests and the inventory example, then packs and installs the
actual tarball into a temporary consumer. That check verifies source/license inclusion, ESM/CommonJS
exports, zero runtime dependencies, and both module formats' declaration consumption. TypeScript is the sole development
dependency. The tests use Node's built-in test runner. No test uses a real model or credentials.

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
call identity, not JSON Schema or application argument semantics. The host must validate arguments
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
reasoning continuity and is a host decision. SDKs, provider-specific HTTP and wire formats belong
in adapters, outside this package. Existing desktop adapters remain in the desktop project.

## Events, errors, and cancellation

`onEvent` is optional, ordered, and awaited. Events are:

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

The same `AbortSignal` reaches providers and tools. Aborting ends an outstanding provider, tool,
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

## Deliberately outside the core

Domain prompts and tools, manual/automatic/planning modes, approval UI, revision-aware mutation
commits, persistence, memory policy, result truncation, model selection, authentication, provider
SDKs, retry policy, compaction, routing, Electron, and any application UI remain host concerns.

## License and origin

Apache License 2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE), and [ATTRIBUTION.md](ATTRIBUTION.md).
This extraction originates from Bot Commander Desktop at source commit
`943e3f84f67e4415a899da8921db84639843c625`. The copyright owner authorized this separate Apache
release; the upstream desktop application's GPLv3 license is unchanged.
