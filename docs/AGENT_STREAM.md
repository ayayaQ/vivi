# Ordered accepted records (prepared 0.10.0)

The optional `@ayayaq/vivi/events/stream` subpath adds bounded v1 run-local records to
[session snapshots](AGENT_RECORDS.md). `runAgent` adds an optional `onAccepted` hook.
Published `0.9.0` does not contain these additions. Hosts adopt verified published bytes
through their separately reviewed migrations. The prepared release is not yet published.

## Canonical acceptance and compatibility

`onAccepted(update)` receives a detached deeply frozen `AgentAcceptedUpdate`:

- `assistant_accepted`: canonical assistant message, accepted round, optional round usage,
  and exact aggregate run usage
- `tool_result_accepted`: canonical matching result and its round

The runner commits history, round and usage first, awaits the hook, then invokes the
existing assistant/tool-completed `onEvent`. The hook is captured once and called without
`this`. When absent, the existing callback scheduling path is unchanged. A thrown/rejected
hook returns `event_error`; cancellation interrupts waiting promptly. Already committed
history and usage remain in the final `AgentResult`. Canonical cleanup closures have no
acceptance callbacks; the final result supplies any unseen accepted tail and closures.

Transient progress, `tool_started`, `round_completed` and the other `AgentEvent` callbacks
remain live notifications. Do not build durable canonical history by guessing from them.
An accepted message proves in-memory runner acceptance, not disk commit, tool delivery,
approval or successful external effects. A generic result may contain a host error string;
the host must screen it before storing or publishing it.

## Record and projection contract

Each record carries `version: 1`, `scope: 'run'`, exact `sessionId`, `runId`, `eventId`,
run-local `sequence`, `previousEventId` and host source reference/revision. Run and session
sequences are distinct. IDs are host-authored and stable; callbacks do not generate them.

1. `createAgentRunStart(envelope, base, input)` anchors to a validated complete
   `AgentProjection` by session sequence, event ID and SHA-256 receipt digest. `input`
   contains only new user/system messages with their original host IDs/sources
2. `createAgentAcceptedRecord({ envelope, update, historyId, source })` records exactly one
   accepted assistant or result. Assistants advance rounds only after every pending result;
   results must match the next exact call ID/name. A text-only assistant ends acceptance
3. `createAgentRunTerminal(envelope, terminal)` wraps the existing host-reconciled
   `createRunSettlement` record. Its independent session successor, canonical input boundary,
   accepted prefix, final rounds/usage and exact call bindings are validated

`createAgentRunProjection`, `applyAgentRunRecord` and `projectAgentRunRecords` provide
frozen incremental/full replay. Only module-created/replayed projections are trusted;
serialized guessed cursors are rejected. Identical old duplicates return the **current**
projection. Gaps, conflicting IDs, unknown versions, malformed order and hostile containers
throw atomically. Receipts keep hashes/byte counts, never old message bodies. Independent
reported token totals and permanently omitted cache counters retain runner semantics.

A terminal may include unseen canonical output and ordered cleanup results after a hook
failure. It cannot change accepted assistants, input or IDs. An accepted generic result
can be replaced only with the same exact call/name, original source reference plus new
explicit revision, and host evidence bound to the original run/call/arguments digest.
That evidence may honestly report `unknown` or `not_attempted`; it need not invent success.
Existing prior durable evidence still obeys the session refinement/supersedes rules.
A prior host-only sidecar is not an invented durable receipt to supersede.

## Host append, commit and recovery obligations

The [offline example](../examples/agent-stream.mjs) uses an in-memory append oracle; paired
CLI/Desktop fixture adapters exercise real host-shaped ownership with synthetic storage.
They establish contract behavior, not physical fsync, native GUI or live provider/MCP readiness.

Hosts screen the entire envelope and returned projection against **current** privacy/policy
before admission, persistence, fanout and publication. `assertAgentRunCurrent(active, currentSession)`
rejects an active baseline after any newer session/privacy/reconciliation cursor. The host
must reload or otherwise verify the current stored session anchor, including after waits;
checking only its own cached projection is insufficient. Use a single serialized owner or
host storage CAS/transaction to prevent a competing writer from committing between those
checks. Core has no lock, IO, secret detector or distributed transaction.

The committed cursor advances only after an exact host append/commit acknowledgement.
If a write fails ambiguously, read back verified bytes: exact record identity permits retrying
that checkpoint acknowledgement; a mismatch is quarantined. This never retries a tool or
provider. An admitted write may outlive cancellation, so hosts must drain their writes
before reconciling and committing the terminal. Stronger exact MCP intent/outcome sidecars
remain authoritative and are acknowledged only after the matching canonical/display/effect
checkpoint is verified committed. A failed checkpoint retains the sidecar and old committed
cursor. There is no exactly-once guarantee.

Restore the validated session chain and its complete run-local chain. `waiting`/`running`
means an incomplete data view; accepted usage is partial, absent evidence is unreported,
and pending effects remain unknown. Restoration never invokes providers/tools, reconnects
servers, reconstructs resources or restores approval. A later action requires current host
policy and exact sidecar reconciliation. A settled run must match its independently verified
session terminal checkpoint; newer session cursors invalidate old active publications.

Legacy import remains the session anchor with original message IDs, source references,
display metadata, title, notes and authoritative aggregate usage. It fabricates no historical
runs, rounds or approvals. Hosts retain the original stored document until the versioned
successor validates and commits. Privacy changes must also scrub/quarantine stored log bodies
and backups. If immutable identities/evidence cannot safely be screened, quarantine rather
than replay secrets. Restore requires the exact screened complete session chain; a privacy
snapshot cannot replace erased prior records. If policy requires old bodies to be removed,
scrub/quarantine that chain and withhold restoration. Sanitized bootstrap/receipt retirement
is optional future work, not a prerequisite or implied capability of bounded v1 adoption.

## Bounds and storage cost

`AGENT_RUN_RECORD_LIMITS` caps ordinary records at 1 MiB, terminal wrappers at 2 MiB,
depth 36, 131,072 nodes, 4,096 unique records, 64 MiB journal bytes and 16 MiB projections.
Full replay bounds its plain array to 4,096 entries including duplicates. Active admission
reserves the final record slot, 2 MiB journal headroom and message slots for pending closures.
The enclosed session terminal still obeys its stricter 1 MiB/depth-32/history-4,096 limits.

**Reserved headroom does not guarantee that arbitrary accepted data fits a terminal.**
The final snapshot repeats cumulative history and answer content; unseen cleanup or provider
state may also add bytes/depth. Hosts must enforce a separate final-envelope budget before
admitting output and retain/quarantine an incomplete run if reconciliation is over budget.
No implicit truncation, compaction, deletion or empty-history fallback occurs. Hosts also
bound encoded input before parsing, retained runs and model-token budgets.

Run-local deltas cost approximately the new accepted payload bytes plus one final session
snapshot per turn. Cross-turn snapshots still cost approximately N × H for N turns and
history size H in the worst case. Limits fail closed; efficient cross-turn persistence and
optional sanitized bootstrap are outside this version. Production CLI-20/Desktop-14
migration remains separately reviewed after verified publication.
