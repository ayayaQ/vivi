# Session records and projections (prepared 0.10.0)

`@ayayaq/vivi/events` is an additive, data-only contract for **settled snapshots**. The
existing `runAgent`, `AgentEvent`, awaited callbacks and provider-native receipts are
unchanged. A live callback is neither a complete journal nor proof of a disk checkpoint.
Build a terminal record from the final **host-reconciled** result after admitted outcome
work drains, even when cancellation or a callback failure suppressed later live events.

The prepared 0.10.0 contract supplies bounded v1 session records, stable source identities,
exact outcome evidence and immutable full/incremental projection. Its additive
[run stream](AGENT_STREAM.md) records ordered accepted assistant/results separately from
transient progress. Published 0.9.0 contains neither these APIs nor CORE-11 owned scopes.
Production CLI-20/Desktop-14 persistence/migration follows verified publication. Mid-log
bootstrap, compaction and receipt retirement are not supported or required for bounded v1 use.

## Records

Every record has `version: 1`, `sessionId`, `eventId`, integer `sequence`,
`previousEventId` and a host-owned `source` reference with an optional revision.
The first record is sequence 1 with a null predecessor. Later records require the exact
previous event and next sequence. Sources identify original data; hashes do not authenticate
them. Hosts choose stable identities and immutable source revisions.

- `run_settled` has `runId`, `inputHistoryLength`, final status/content/rounds/run usage/error and a full snapshot
- `session_snapshot` has reason `legacy_import`, `privacy` or `reconciliation` and a full snapshot
- Each snapshot has ordered `{id, source, message}` history entries, exact host-provided
  outcomes and authoritative **session aggregate** usage. The aggregate replaces prior totals
- `legacy_import` is an initial anchor. It does not invent historical runs, rounds, cache
  counts, source revisions or approvals. Titles, notes, display/validation evidence and
  original recovery data remain in the host's versioned envelope

History is settled canonical `HistoryMessage` data, preserving role and opaque providerState.
Call IDs are unique and results match the next pending call. Incomplete accepted/live state,
text deltas and provisional metrics do not enter this format. A host first closes interrupted
history with its existing exact outcome reconciliation, without executing historical calls.

`createRunSettlement` checks exact equality between the supplied history messages and
`result.history`. It preserves `result.content`, including empty content in a zero-round
cancelled/error run that retains earlier assistants. The explicit canonical input-prefix length distinguishes prior history from this run's accepted suffix; rounds/content match that suffix. Hash-only call/run bindings retain the
original run for later evidence without inventing legacy run IDs. Session usage is supplied separately
by the host. Token totals are independent reported counters; optional cache fields stay
omitted when unreported. Repeating a record never adds history or usage again.

## Outcome authority

Outcome evidence names original `runId` (or null if genuinely absent), `callId`, tool name,
canonical `argumentsDigest`, status, effect and source. `agentArgumentsDigest` provides
sorted-key SHA-256 binding. Evidence must match a historical call; new evidence binds the retained original
argument digest for a known run, or exact current arguments when no prior binding exists. A new run's evidence uses that run ID.

Status is presentation of the host outcome (`succeeded`, `failed`, `denied`, `cancelled`,
`unknown`). Effect is independently `not_attempted`, `confirmed`, `unknown` or `unreported`.
Absent evidence is unreported/unknown, never permission or proof of no send. `tool_started`,
generic tool success/failure and cancellation establish no external delivery fact.

Existing exact MCP intent/outcome sidecars remain the send/effect authority. This API does
not execute, approve, retry, start a server, retire evidence or acknowledge a checkpoint.
Sidecars may only be acknowledged by the host after an exact successfully committed
checkpoint includes matching canonical/display/effect evidence. A failed save retains the
old committed cursor and stronger sidecar receipt, even when observation advanced in memory.
There is no exactly-once or distributed-transaction guarantee.

Earlier evidence cannot disappear or change exact call/run/argument binding. Unknown or
unreported evidence may refine to unknown/confirmed evidence (unreported may also become exact not-attempted evidence) with the same source reference,
a changed explicit revision, and `supersedes: agentEvidenceDigest(previousEvidence)`.
Confirmed and not-attempted evidence cannot be weakened. A reconciliation snapshot may
replace a historical tool result only alongside refined exact host evidence. No other
normal record may rewrite the ordered historical prefix.

## Privacy and recovery

Hosts must screen the **whole envelope** before persistence, fanout and restored-projection
publication: history, arguments, providerState, outcome sources, metadata and references.
Core has no credential detector or policy authority. If a newly detected secret occurs in
an immutable ID/source/evidence field that this version cannot safely rewrite, the host
quarantines the chain and withholds publication until a validated migration exists. It rejects non-JSON data, proxies,
accessors and unknown fields; this is structural validation, not secret screening.

An explicit privacy snapshot can redact historical payloads or remove optional opaque
providerState. It keeps ordered message IDs, roles, call/result identities and exact outcome
digests, and each changed entry retains its source reference with a new explicit revision.
The host preserves exact sidecar identity bridges and performs physical deletion,
invalidation, sanitized rewrite/backup/quarantine and commit policy. No old content is kept
in projection duplicate receipts; run summaries retain no answer/error body. An identical
old event returns the **current** projection, so it cannot undo a privacy rewrite.

Hash-only receipts do not sanitize old stored log bodies. A privacy snapshot alone cannot
restore a chain after earlier records are erased. Keep exact screened replay bodies, or
scrub/delete/quarantine the chain and withhold its restoration when current policy requires
removal. Do not rewrite old bodies and pretend their receipt digests or original call bindings
are unchanged. Continued same-session recovery after prefix erasure requires a future
explicitly reviewed checkpoint/migration contract. Full replay is atomic to its
caller, but a host publishing intermediate catch-up states must screen each publication.
Never expose a pre-redaction projection or revive deleted/disabled context through replay.
New records are screened against current policy; long waits never preserve reusable approval.

Restore by `projectAgentRecords(sessionId, storedChain)` from sequence 1. JSON-serialized
projection objects are not accepted as trusted cursors. Missing/corrupt/unsupported records,
session mismatch, gaps and conflicting event-ID reuse throw; the old projection remains
unchanged. No empty-history fallback or guessed sequence-N anchor exists. The host retains
original legacy data until its versioned successor is validated and durably committed.

The projection sequence/event ID is an observation watermark, not a commit receipt. A host
must compare its own committed watermark and buffer newer events while loading snapshots;
an older snapshot or prior-run terminal frame cannot replace newer state. Replay never
restores process resources, live subscriptions, policy permits or approval.

## Bounds and cost

`AGENT_RECORD_LIMITS` caps each UTF-8 JSON record at 1 MiB, depth 32, 65,536 nodes,
4,096 messages, 2,048 outcomes, 256-character identities and 2,048-character source references.
Session chains stop at 2,048 unique records or 64 MiB cumulative serialized bytes;
full replay also bounds its plain input array to 2,048 entries, including duplicates;
current projection data stops at 8 MiB. Rejected/duplicate records do not grow the journal.
Hosts must also bound encoded input **before JSON parsing** and impose their own retention
and model-token budgets. `decodeAgentRecord` accepts already parsed plain JSON, not text.

Full snapshots deliberately trade simplicity for repeated bytes. A history of H bytes across
N turns costs approximately N × H in the worst case, plus metadata/evidence. The 64 MiB
limit fails closed; it does not compact, truncate or silently drop history. The additive [run stream](AGENT_STREAM.md) stores accepted deltas within each turn and
retains this terminal session anchor. Session snapshots still repeat cumulative history;
receipt retirement, efficient cross-turn compaction and sanitized bootstrap are optional
future contracts, not assumptions made by this bounded complete-chain API.

The [offline example](../examples/agent-records.mjs), decoder tests and paired CLI/Desktop
fixture adapters demonstrate this contract. They do not change either production host or
claim physical append/fsync, native GUI, real provider or MCP readiness. Core imports no
filesystem, process, OS or UI modules; only pure Node crypto/util support bounded data/hash
operations. Existing historical restricted host assessments remain excluded.
