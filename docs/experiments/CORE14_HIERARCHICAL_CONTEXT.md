# CORE-14: bounded offline hierarchical-context evaluation

Status: experimental source/automated evidence, 10 October 2026. No shipping decision,
host integration, new export, version change, npm publication or live provider trial.

## Decision and scope

Keep the current full-history behavior and explicit app-wide memory. This experiment does
**not** support adopting hierarchy: under this deliberately lossy mock, hierarchy loses
more evidence and does more summarization work than incremental flat compaction. Exact
source search recovers the declared evidence for both. These findings establish fixture
mechanics and a comparison method, not real-model recall, answer quality or economics.

The [CORE-14 card](https://chatgpt.com/space/page_d1ad67b5da608191a300e551f174b11f)
is evaluated using existing v1 source-bearing records and an owned synthetic corpus.
The [architecture audit](../adr/0001-owned-lifetimes-and-durable-events.md) keeps source
screening and persistence with hosts. No event rewrite is needed: `projectAgentRecords`
provides stable history IDs, source references/revisions and original message roles.

[Taelin's UniiChat design](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)
inspired the append-log binary summary tree, exact-source zoom and high-to-low batching.
Its single enduring chat, immutable originals, summary-only recent view, byte-only budget,
latest-mention authority and simulated cache economics are not adopted. References are
design context, never executable instructions or evidence of Vivi performance.

## Method and independent oracle

- 95 invented entries, 11 complete tool exchanges, Unicode and unrelated repetition;
  no real user transcript, secrets, external actions or provider calls
- 12 independently authored probes, three each for corrections, role conflicts,
  unfinished/completed work and exact details; 47 required supporting/conflicting quotes
- The mock retains an input prefix within a checked limit. It cannot see queries or
  expected answers. A buried detail deliberately tests omission, and newer tool/assistant
  mentions conflict with authoritative user/system sources
- Both primary comparators receive the same arrivals, explicit memory, four whole recent
  entries, 6,000-byte/6,000-mock-token request ceilings, 65% batching target, mock callback
  and equal exact-source search access. Hierarchy stores binary nodes; ordinary incremental
  flat compaction summarizes its current older view at overflow
- A separate one-shot flat rebuild is reported as a diagnostic, not mixed into arrival
  workload costs. The unchanged actual full-history baseline is also reported. Vivi core
  and inspected CLI/Desktop sources contain no shipped conversational summarizer; the
  two compaction algorithms here are experimental comparators

“Evidence availability” counts whether a required verbatim quote survives in the rendered
view, or is returned with its exact expected ID/source/role through the separately tested
source search. It is not a semantic recall score, an answer generator, authority resolver
or proof that a model will choose the correct evidence. Common query needles are hand
authored; discoverability of an unknown needle remains unmeasured. Equal search recovery
cannot be credited to hierarchy. Zoom opens actual children and finally the exact source;
it cannot recover an omitted clue merely by knowing which node to open.

## Deterministic mock results

The reproducible [JSON results](CORE14_MOCK_RESULTS.json) contain every probe and source role.

| Same-arrival comparator | Hierarchy | Incremental flat |
| --- | ---: | ---: |
| Evidence quotes in final view | 7 / 47 | 14 / 47 |
| Probes with all required view evidence | 0 / 12 | 1 / 12 |
| Evidence with equal exact-source search | 47 / 47 | 47 / 47 |
| Final request UTF-8 bytes | 5,111 | 4,963 |
| Final mock tokenizer units | 5,111 | 4,962 |
| Summary callback calls | 109 | 5 |
| Summary input/output mock units | 27,488 / 17,440 | 18,818 / 11,040 |
| View batches | 5 | 5 |
| Equal leading bytes across arrivals | 270,995 / 411,755 | 284,095 / 416,818 |

Hierarchy preserves more evidence on two probes, less on seven, and ties on three. Both lose
important corrections/conflicts and exact details without source retrieval. The unchanged
full-history baseline preserves all 47 evidence quotes but needs 31,120 bytes and 31,109
mock units, exceeding this experimental request ceiling. The one-shot flat rebuild uses
one callback and 5,872 bytes; it is a different workload and retains different evidence.

Work/cost proxy: the sums of checked mock summary input/output units are 44,928 for
hierarchy and 29,858 for incremental flat. For any hypothetical input/output rates, a
symbolic estimate is `input units × input rate + output units × output rate`; the units
are not provider tokens, so this is **not a dollar estimate**. Sequential callback count
is a latency-work proxy, not provider milliseconds. Hierarchy eagerly builds all binary
parents, including nodes unused in the final view. The bounded prototype scans/revalidates
up to 256 sources; these work counts establish no scalability or optimized-production claim.

Leading-byte equality is local serialized prefix overlap only. Different JSON framing,
tokenization, provider cache markers, TTL, model/account identity, network and concurrency
could change actual caching. There are zero real provider/cache/cost/latency measurements.
The named codepoint mock tokenizer and doubled-unit adversarial tokenizer test independent
token and byte enforcement; neither stands in for a real model tokenizer.

## Acceptance mapping and durability failure cases

| CORE-14 requirement | Offline proof / limitation |
| --- | --- |
| Recent verbatim window and explicit memory | Whole original recent entries and separate memory are rendered; insufficient headroom withholds context rather than truncating them |
| Exact-source search/zoom and provenance | Existing record projection, exact ID/source/revision/role equality, recursive child-to-source zoom, detached return values |
| Corrections/conflicting instructions | Oracle includes authoritative and stale/conflicting sources; later tool claims remain tool data; no automatic latest-mention truth |
| Delete/disable/revise/recognized secret | Reconcile before reuse; affected summaries, related descendants and derived caches are purged. Secret screening covers complete source envelopes, summary output, saved nodes and explicit memory; screened memory withholds the request until refreshed |
| Model-token and byte budgets | Checked complete request and exact retrieval, bounded summary input/output, named injected tokenizer; malformed counts fail. Real tokenizer validation remains a live/product gate |
| Failed summary | Rejection, timeout and oversized output have at most two attempts per node and a short explicit unavailable marker; original source retrieval remains intact |
| Recoverable versioned state | Bounded v1 JSON, checksum, tokenizer/memory/limits/source fingerprint validation, structurally checked node links/coverage and saved-view preservation |
| Durability failures | Corrupt/truncated/unknown-version or incompatible state is quarantined with context withheld, then rebuilt from authoritative current sources; failed simulated commit leaves the previous checkpoint recoverable; changed/deleted/screened sources never reuse saved summaries |
| Comparison | Same-arrival flat compaction and unchanged full-history baseline, per-probe evidence, bytes/mock units, callback work, prefix bytes and explicit failure evidence |

The checkpoint checksum detects accidental corruption; it is not authentication of hostile
state and does not prove summary semantics. Checkpoints omit original source bodies, which
remain in the authoritative input records. Rebuilding requires those current records, never
an empty-history fallback. Tests simulate commit failure in memory; they do not prove file
locking, fsync, atomic rename, backup or disk durability. Those policies remain host-owned.
Flat's compressed view can be regenerated from the same retained records; no durability
advantage over that baseline is established. Privacy erasure of persisted old record bodies
still follows the existing core/host quarantine contract, not this experiment.

## Reproduction and gates

After `npm ci`, run `npm run build` and `node --test test/hierarchical-context.test.mjs`.
The normal `npm run check` includes the experiment test on supported Node 22/24 runtimes.
To regenerate the JSON, import `evaluate` from
`test/fixtures/hierarchical-context-evaluation.mjs` and serialize its returned result.
The test compares regenerated results byte-for-byte as structured data with the committed
result file. No credentials, network or actual provider are needed for the experiment.

Before any future adoption: choose product scope deliberately; use separately authorized
representative corpora, real tokenizers and real summarizers; evaluate generated answers,
retrieval discovery, source policy and durability in actual hosts. Measure provider cache,
latency and dollars only in a separately approved trial. Keep app-wide memory, host approvals,
unknown-effect authority, human-approved MCP and existing default context behavior intact.
