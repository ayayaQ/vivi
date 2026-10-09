# Optional MCP bridge

`@ayayaq/vivi/extensions/mcp` shares the catalog, proposal and content pieces of the
CLI MCP implementation. It adds no runtime dependencies and does not import the MCP
SDK. This source prepares `0.9.0`; verified npm `0.8.0` does not
include this subpath. Consumer adoption waits for a reviewed registry publication.

## Boundary

The module supplies bounded explicit-page discovery, stable per-server aliases,
conservative schema quarantine, immutable exact-operation bindings, a fixed turn
extension, local resource metadata and bounded untrusted result projection. Tool
schemas and constraints are preserved. Unsupported schemas are quarantined rather
than weakened. Only already-discovered concrete resource URIs can be proposed;
templates stay metadata-only. Binary bodies are omitted and links are never followed.

Hosts own every connection, installed process, configuration and persistence,
protocol negotiation, credentials, privacy policy, human approval, active-run checks,
actual send, cancellation/cleanup and history/checkpoint handling. Neither a catalog,
server annotation, operation binding, schema validator nor a review recommendation
authorizes execution. The bridge is trusted in-process code, not a sandbox.

## Host wiring

Create one extension for the catalogs captured at the start of a host turn:

```js
const extension = createMcpExtension(host, capturedCatalogs, reviewOperation, {
  validateSchema, assertAllowed,
  operationsEnabled: true
})
```

- `host.captureCatalogs(signal)` returns current local metadata without starting,
  connecting, discovering, refreshing or reading a server
- `host.prepareOperation(snapshot, entry, kind, call)` validates the proposal against
  its current connection and launch identity. The exported `prepareMcpOperation`
  helper creates the frozen exact binding; `assertMcpOperationCurrent` and
  `mcpOperationRevisions` support repeated host comparisons
- `validateSchema(schema)` returns a synchronous argument assertion. It must enforce
  every supported constraint, perform no fetching, throw on invalid schemas/arguments
  and return `undefined` on success. The host can adapt its own validator; for the
  CLI's pinned official SDK `@modelcontextprotocol/client@2.3.1`, an adapter is:

```js
const validateSchema = schema => {
  const validate = new AjvJsonSchemaValidator().getValidator(schema)
  return arguments_ => {
    if (!validate(arguments_).valid) throw new Error('Invalid MCP arguments')
  }
}
```

- `assertAllowed(value)` is a mandatory synchronous host privacy assertion. Apply
  known-credential checks and other host policy before metadata, arguments and results
  are admitted. No credential detector is shared, and this contract does not claim
  detection of arbitrary encodings or retroactive removal from past history
- `reviewOperation(operation, signal)` is mandatory trusted host wiring. It must
  obtain human approval for that exact external call/read, including automated host
  modes, and may return `mcpFailure` for denial or cancellation. A throwing/malformed review
  response is conservatively marked as an unconfirmed outcome; the bridge cannot infer
  whether its host sent a request. It owns invocation
  and uses `projectMcpResult` for confirmed results
- `operationsEnabled: false` withholds every external alias and the resource-read
  tool. The captured local resource-list tool can remain. Hosts choose this capability;
  the module has no application or session modes

The local resource-list tool detects changes instead of acquiring new metadata during
the turn. Capture new catalogs and construct a new registry on the next turn. Keep the
fixed `MCP_RESOURCE_TOOL_NAMES` unavailable to unrelated built-in/extensions even when
no resource tools are currently advertised. Use the ordinary fixed `createToolRegistry`
for collision checks and frozen definitions.

## The actual send remains host-owned

Pure binding comparison and calling a host callback cannot guarantee wire behavior.
The host adapter must re-read persisted configuration, assert current launch/catalog/
schema/arguments and active turn at the **actual transport send boundary**, consume a
one-shot approval and compare the outgoing exact method/params (including only the
SDK's expected protocol metadata). Reject concurrent/repeated attempts. Do not permit
SDK reconnect/retry, cache-served resource bodies or automatic input fulfilment. Apply
bounds before wire JSON decoding, and keep server errors/stdio away from provider,
transcript and diagnostic logging. Invoke only after the host's final policy checks.

If the request was sent and a result, cancellation or error leaves its outcome
unconfirmed, return `mcpFailure(code, message, true)`, invalidate that connection and
do not retry automatically. Cancellation cannot undo effects. The host must preserve
`unknownOutcome` and `doNotRetry` through UI, history, recovery and result processing.
The ordinary shared `runAgent`/`createToolRegistry` abort path can discard a returned
host projection and synthesize generic cancellation history. Returning `mcpFailure`
is therefore insufficient as the only record of a sent attempt. Record exact attempted
operations and settled/unconfirmed outcomes in a bounded host-owned ledger before send;
settle it even while cancellation unwinds. After the runner settles, reconcile the
matching terminal call-result pair by captured session/run/call/alias identity, and
preserve it through checkpoint failures and restart recovery. This records outcomes,
never reusable approvals. Persist conservative send intent before the boundary; if
outcome/terminal-history checkpointing fails, retain that evidence and reconcile it as
unconfirmed on restart. Send intent alone does not prove delivery; do not claim a
confirmed send from an unsettled intent record. Confirmed not-attempted (`requestSent:false`) must remain
separate from sent/potentially-sent unknown effects (`unknownOutcome:true`, `doNotRetry:true`)
in both persisted history and display. Preserve a confirmed result when known; never
replace uncertainty with a generic "cancelled, not sent" inference. It must not replay a sent attempt or infer identity from an
untrusted `result.source` field. The offline adapter test explicitly demonstrates the
raw cancellation loss, zero-send cancellation, one-send uncertainty, persisted/displayed
results and restart reconciliation after a failed checkpoint; the core runner is unchanged.

Do not run app-specific clipping on the projected JSON: truncating it can remove its
source, untrusted marker or unknown-outcome semantics. Reject oversized content instead.

## Bounds and supported slice

Catalogs are bounded to 16 pages, 256 entries and 1 MiB per category, with bounded
individual descriptors, JSON depth/node complexity, cursor checks and deadlines.
The shared extension accepts at most eight captured server catalogs and advertises at
most 128 external tools within 128 KiB. Arguments are at most 16 KiB; projected result
JSON is at most 64 KiB with at most 128 content items. A timed-out discovery adapter
must honor cancellation; the pure collector cannot stop host-owned work that ignores it.

Only the CLI-demonstrated safe schema subset is accepted: no reference/compound/regex/
header-dependent schemas, unknown dialects or mandatory task execution. Unknown
annotations confer no trust. Tools and resources are optional categories; error, stale,
unsupported and never-requested catalogs cannot authorize an operation. Prompts,
tasks, subscriptions, input fulfilment, authentication, HTTP and installation are not
provided by this shared slice.

[The offline example](../examples/mcp.mjs) uses a synthetic schema assertion and fake
host responses. Tests include CLI-shaped and desktop-shaped adapters, mutable source
catalogs, schema rejection, stale bindings, host denial, metadata-only capability and
unknown-outcome preservation. They do not establish real-server, native-process or
live-provider readiness. Hosts are adopted and reviewed separately after publication. CLI adoption must add this
attempt/outcome reconciliation alongside its existing privacy checkpoints; current CLI
`c748317` terminal history is taken from the runner and has no MCP outcome-ledger drain.
Desktop adoption must implement the same terminal/recovery guarantee before enabling calls.
The synthetic adapters establish this explicit obligation, not an already-shipped host fix.

## Provenance

Extracted from Apache-2.0 [vivi-cli at c748317](https://github.com/ayayaQ/vivi-cli/tree/c748317cb87a72f4e023cc21b96e793ea89e3170),
particularly `mcp-catalog.ts`, `mcp-manager.ts`, `mcp-tools.ts` and `mcp-content.ts`.
The host seam and compiler injection replace CLI-specific dependencies; no SDK source
is copied or vendored. The official [SDK calling guide](https://ts.sdk.modelcontextprotocol.io/v2/clients/calling)
and [connection guide](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect) were
checked on 2026-10-09: high-level list methods aggregate pages, so a host adapter uses
explicit one-page requests for this collector; timeouts/cancellation and automatic
input handling must be configured explicitly by that host.
