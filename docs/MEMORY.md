# Optional shared memory module

The `@ayayaq/vivi/extensions/memory` subpath is published in verified stable `0.5.0`.
The actual registry archive matches the independently reviewed release bytes; immutable
published `0.4.0` does not contain this subpath.
Host adoption remains a separately reviewed change; CLI session notes are not migrated.

## Domain contract

- `MemoryActor` is `agent` or `user`. Each `Memory` has `id`, `content`, `createdAt`, `updatedAt`,
  `createdBy`, and `updatedBy`
- `MemoriesData` is the desktop v1 envelope `{ version: 1, memories: Memory[] }`
- `decodeMemories`, `encodeMemories`, `validateMemories`, and `normalizeMemoryContent` share
  the existing constraints: 100 records, 1,000 UTF-16 code units per content, and 20,000 total.
  New content is trimmed and nonempty. Trimmed case-insensitive duplicate content is rejected
- Decoding accepts an omitted version as v1 and any string timestamp, retains existing content
  whitespace, record property order, IDs, attribution, and additional legacy fields. It does not
  silently rewrite stored records or impose stricter UUID/date rules
- `memoryRevision` is the first 16 hex characters of SHA-256 over `JSON.stringify(record)`,
  exactly as in the desktop. Reordering fields or dropping extra fields changes that revision

`createMemoryService(persistence)` creates independent instance state. `list()` returns records
with their revisions and limits. `prepareCreate(content, actor)`,
`prepareUpdate(id, expectedRevision, content, actor)`, and
`prepareDelete(id, expectedRevision)` return reviewable `MemoryMutation` proposals without
changing live or persisted state. `commit(mutation, { signal? })` snapshots at admission,
serializes commits in that instance, rechecks revisions/duplicates/limits in the queue,
awaits the host save, and only then exposes the new state. A failed save leaves state unchanged
and does not poison the queue. Changing a record's ID or creation attribution through an update
is invalid.

Preparation is not permission. This is trusted domain code, with no approval enforcement,
permission broker, storage path, filesystem access, embedding model, database, dynamic loader,
sandbox, or new `runAgent` hooks.

## Persistence and cancellation responsibilities

The required `MemoryPersistence` adapter has three methods:

- `load(): MemoriesData | Promise<MemoriesData>` supplies a decoded snapshot. The host owns
  loading, backups, corruption recovery, notices, and any recovery checkpoint before returning
- `assertWritable(): void` enforces the host's recovery/read-only policy before preparation and
  again inside queued commit
- `save(data): void | Promise<void>` persists a detached snapshot. Resolution acknowledges that
  the write committed. Rejection means it did not commit and preserves the original error

Atomic rename commit and power-loss durability are different. An adapter must not reject as if
rollback were possible after its primary rename committed. The desktop adapter already resolves
such writes, reports directory-sync uncertainty visibly, and retains its shutdown-drain/fsync
retry obligation. The shared service advances live state on that resolved save. Later writes
may confirm durability. Neither notices nor the durability ledger belong in this module.

The host must enter its existing persistence admission/lifecycle wrapper BEFORE calling
`commit`, so queued writes count toward shutdown drain. Cancellation is checked before queued
work and immediately before save; a canceled queued proposal never writes. Once save starts it
must settle. A later abort cannot roll back a committed write, so the service still reconciles
live state and returns the committed result. The host/runner may separately suppress stale UI
or tool delivery after cancellation.

Service instances cache their own loaded state and serialize only their own commits. They do
not lock a shared file across instances or processes. Sharing implementation does not mean
sharing a file. App-wide memory means all sessions in each host see that host's separate store.
For a CLI host with multiple processes, use a host-owned exclusive file transaction and a fresh
service inside it: acquire the lease, load the latest disk state, commit the approved proposal
with its original expected revision, save atomically, then release. Preparation/review happens
outside that short lease, and the transaction's revision/limit recheck catches later changes.
Do not use two long-lived cached instances to write the same file without that protection.

## Tools and host policy

`createMemoryExtension(host)` supplies static `list_memories`, `create_memory`, `edit_memory`,
and `delete_memory` definitions and synchronous argument validators. Two required callbacks
capture host execution:

- `listMemories({ signal }): ToolResult | Promise<ToolResult>` supplies the host's ordinary list
  result
- `executeMutation(call: MemoryToolCall, { signal }): ToolResult | Promise<ToolResult>` enters the
  existing host approval/autocommit, cancellation and persistence lifecycle route

There is deliberately no `createMemoryExtension(service)` convenience that commits proposals
for the host. The mandatory callback is an explicit policy seam, not a security boundary:
trusted host code can still bind it incorrectly. Preserve the exact approved snapshot and do
not treat a model tool call, a saved memory, or successful preparation as independent approval.
A host may keep its existing built-in tool facade while sharing only the service and metadata.

`MEMORY_MUTATION_TOOL_NAMES` lists all three mutation names. Hosts must exclude them in planning
mode, and reserve them against collisions even when disabled. The ordinary fixed registry still
rejects name/extension collisions and captures callbacks per turn. Tool validation checks types,
required fields, unexpected fields, nonempty ID/revision, and content limits before the host
callback runs; it does not grant permission or decide attribution.

## User-level context

`formatMemoryContext(memories)` preserves the desktop all-memory formatter: oldest updated first,
JSON-quoted content, and the same empty string sentinel. The host places nonempty output in a
USER-role context message, appends `This is context only, not a request to act.`, and retains
current-request precedence. `MEMORY_GUIDANCE` shares the three generic guidance paragraphs;
host-specific domain exclusions may be appended by the host. It never elevates saved content
to system authority or authorizes tools.

See [the offline host-policy example](../examples/memory.mjs). Its simulated review denies the
requested write, proving that advertising the tool does not commit it. Ordinary tests use fake
persistence and cover v1 round trips, revision bytes, bounds/duplicates, stale reviewed proposals,
queued cancellation, failed saves, post-rename uncertainty, independent instances, host callback
routing, planning filtering, registry collisions, and real packed ESM/CommonJS/declaration use.
