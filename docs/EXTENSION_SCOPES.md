# Owned extension scopes (published 0.10.0)

Registry 0.10.0 bytes are verified; host adoption remains separately reviewed.

`createExtensionScope` is an opt-in export of `@ayayaq/vivi/extensions`. It owns explicitly
imported v1 registrations and host-provided cleanup. It adds no loader, event bus, sandbox,
permission grant or runtime dependency. `ToolExtension` and `createToolRegistry` are unchanged.

```ts
const scope = createExtensionScope({ reservedNames: ['host_tool', 'disabled_host_tool'] })
scope.register(calculatorExtension)
scope.defer(unsubscribe)
const registry = scope.snapshot()
try {
  await runAgent({ provider, messages, tools: registry.tools,
    executeTool: registry.executeTool, signal: scope.signal })
} finally {
  await scope.dispose()
}
```

## Registration and turns

Construction validates and captures reservations once, including disabled host names. Each
`register(extension)` validates and captures the entire candidate before publishing anything.
Malformed contracts, duplicate extension IDs, or tool/reserved-name collisions throw and leave
prior registrations intact. Definitions are detached and deeply frozen; validator and executor
references are captured at registration. Source edits cannot replace them.

`snapshot()` requires an open owner and returns a fixed `ToolRegistry`. Pair its definitions and
executor for the whole turn. Later registrations appear only in later snapshots. A retained
snapshot keeps its original `tools` and `has` facts after closure; dispatch rejects with the
owner's abort reason and cannot acquire tools from a replacement scope. Advertisements do not
authorize execution: hosts still enforce exact owner/run/revision, privacy, approval and hard-deny
checks at their action boundaries.

## Closing and cleanup

- `state` moves irreversibly from `open` to `closing` to `closed`
- `dispose()` synchronously seals registration and aborts `signal`, before awaiting cleanup
- `register`, `defer` and `snapshot` throw once closing begins
- `defer(cleanup)` requires a function and an open scope; record it immediately when ownership transfers
- Cleanup callbacks run without `this`, sequentially in reverse registration order. Every callback is
  attempted, including after earlier failures; returned promises are awaited
- Every `dispose()` call returns the same promise, including calls from an abort listener. Failures
  reject with one memoized `AggregateError`; its `errors` retain the original thrown values in cleanup
  execution order. Rejection still leaves the scope closed

Tool execution observes a combined caller/owner signal. Either source can restrict it; neither
can widen the other. Forwarding listeners are removed on abort or settlement, including errors.
Direct registry calls still await arbitrary executor promises, as static registries do. Closing
does not forcibly stop trusted JavaScript or wait for unregistered work. Hosts cancel their runner
with the owner signal (combined with caller cancellation when needed); `runAgent` retains prompt
cancellation of uncooperative tools/providers/live callbacks.

Register cleanup for owned subscriptions and admitted durable work. Host callbacks must check
current owner/signal on entry and again after awaits before further effects. Unsubscribe prevents
new delivery; it cannot undo effects or stop arbitrary code inside an already-entered callback.
Keep admitted persistence/delivery effects tracked until they settle and await that drain in
cleanup. Live callbacks remain distinct from durable terminal settlement.

## Candidate and late acquisition obligations

Use a fresh unpublished scope for setup. Publish it only after registration/acquisition and
required previous-owner teardown succeed. On failure, dispose that candidate and preserve the
prior published owner. If both setup and cleanup fail, report both failures. A cleanup failure
must remain observable; preserve existing retryable manager/process records and their domain
bounds rather than silently discarding them.

An async acquisition can finish after disposal. The host must release that exact resource
immediately; never adopt it into a newer scope. For example:

```ts
const resource = await acquireResource()
if (scope.state !== 'open') {
  await resource.close() // Propagate cleanup failure to the acquisition's caller
  scope.signal.throwIfAborted()
}
scope.defer(() => resource.close())
```

The state check and `defer` have no intervening await. The host owns the acquisition promise and
must observe its failure; scope disposal does not await an acquisition whose cleanup has not yet
transferred. Register additional domain drains where the host requires them.

A run may own listeners and tool registrations while MCP connections remain app-owned. Do not
register app connection/process shutdown on a run scope. Static calculator/skills packs acquire
no disposable resources by themselves. See the [lifecycle tests](../test/extension-scope.test.mjs)
and [paired offline host adapters](../test/extension-scope-hosts.test.mjs). These prove core/adapter
contracts; production CLI/Desktop dependency adoption and ordinary/native host CI are separate
release gates.
