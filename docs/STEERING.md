# Optional queued-message steering (unreleased)

`runAgent` accepts an optional `getSteeringMessages({ signal })` callback returning
`readonly Message[]` or a promise of that array. Each returned message must have
`kind: 'message'`, `role: 'user'`, and string `content`. This additive API is prepared
for review separately from the current `0.13.0` foundation. No package version or
publication is changed by this work.

## Admission boundary

The callback is captured and validated once, invoked without `this`, and receives the
run's abort signal. Core calls it after the accepted assistant, all sequential matching
tool results, and the existing `round_completed` event. It never runs before the first
provider request or between calls in a multi-tool batch. A text-only response also
reaches this boundary: admitting at least one queued user message continues generation
instead of completing the run. An empty batch leaves existing completion behavior intact.

Core polls only if another provider round fits within `maxRounds`. The limit still
counts accepted provider responses, including each text-only response, and remains
1..1000 with default 25. At exhausted budget a text-only response completes and a tool
response ends with `max_rounds` after its results. Neither consumes queued messages;
the host decides how and when to start a later run for them.

Enabling the callback requires exact canonical fields in both `options.messages` and
each returned steering message, using the same field checks as durable history records.
User messages have only `kind`, `role`, and `content`; assistant/tool-result history,
tool-call envelopes, and provider-state envelopes likewise allow only their documented
fields. Host IDs and application metadata belong in a separate sidecar, not on messages.
Without the callback, published initial-history validation and JSON metadata retention
are unchanged; `validateHistory` retains that legacy contract too.

Every returned batch passes plain-JSON and complete-history validation, exact field
checks, then the user-only restriction. The whole batch is validated before any
user admission. Sparse arrays, accessors, cycles, invalid roles, assistant/tool-result
history, unknown fields, and malformed content fail as `invalid_input`; no part of that
batch is admitted. Core clones each validated occurrence independently and appends it
in FIFO order, even when the host repeats the same object. Equal-content occurrences
stay separate.
User input does not advance rounds or add usage.

After each append, `onAccepted` receives a detached deeply frozen update:

```ts
{ type: 'user_message_accepted', message, round }
```

`round` is the completed provider round at that boundary, not a future generation.
Core awaits this hook before admitting the next user message or requesting the provider.
The existing `AgentEvent` union and event order are unchanged; there is no additional
user event. With `getSteeringMessages` absent, the old path adds no awaited no-op.

## Host queue and acknowledgement

The host owns the queue, identities, input UI, bounds, persistence, privacy screening,
and acknowledgement. The callback must offer a snapshot without destructively removing
unacknowledged entries. Core cannot put messages back into a host queue.

Retain each offered message until its exact admission is reconciled through `onAccepted`
and/or final `AgentResult.history`. Associate each offered FIFO occurrence with its stable
host identity/source. Do not match by content alone, deduplicate equal messages, or remove
an entire offered batch when only a prefix was accepted. Track already acknowledged
occurrences so terminal reconciliation cannot acknowledge them twice. Messages added to
the host queue after capture remain for a later boundary or run.

Admission precedes the acceptance hook. A thrown/rejected hook, failed host commit, or
abort during its wait can therefore leave a canonical user in returned history even if
the host never acknowledged it. Only the admitted prefix remains after a mid-batch hook
failure; the remaining offered entries stay queued. Hosts must drain any already-admitted
writes and reconcile the exact final history before retrying a storage acknowledgement
or starting another run. A callback does not prove durable commit or external effects.

A throw/rejection from `getSteeringMessages` ends the run with `event_error`, preserving
all earlier accepted history and usage. Waiting for this callback or `onAccepted` races
abort even when the host ignores the signal. Cancellation is `cancelled`; late resolution
or rejection cannot append input, start a provider, or change the final result. Invalid
callback configuration/getters fail initial validation before provider work.

## Force-send and cancellation ownership

Queued steering does not interrupt a tool. A host may implement force-send by aborting
its current run, waiting for its returned transcript and admitted writes, reconciling
exact tool/effect outcomes, and starting a new run with the queued user input. Accepted
pending calls receive existing cancellation closures. In-process work that ignores abort
can still finish or produce external effects; cancellation neither rolls them back nor
authorizes retries. Approvals, executor resources, and effect-ledger reconciliation remain
host-owned. There is no new interrupt, restart, or execution-authority API.

## Records and replay

`createAgentAcceptedRecord` and `/events/stream` add the matching `user_message_accepted`
record with its original host history ID/source and completed round. It is allowed only
after a provider round and after all pending tool results, with exact current-round
matching. It adds no usage. A later assistant may follow a text-only assistant only when
an intervening user was admitted. User/system messages remain distinct; steering cannot
add system instructions or rewrite accepted identities, content, or provenance.

The final session settlement can include admitted user input, including a trailing unseen
user after cancellation or hook failure. A completed steering run must end with an accepted
text-only assistant. Terminal recovery preserves the canonical input boundary and the
same no-split transitions. No-steering records retain their earlier validation behavior.
Unknown types/fields/versions are rejected; older published run readers fail closed on the
new user-record type, and older session readers reject a steering-containing output suffix.
Replaying records is data reconstruction and never restores providers, tools, approval,
connections, or execution authority. Existing [host commit and recovery obligations](AGENT_STREAM.md)
and [session snapshot limits](AGENT_RECORDS.md) still apply.
