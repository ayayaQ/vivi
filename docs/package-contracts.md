# Installed projection and diagnostic contracts

The fixtures in `test/package-contracts/` consume only the public installed
`@ayayaq/vivi` and `@ayayaq/vivi/providers/openai` exports. `runtime.mjs` imports
the ESM provider; `runtime.cjs` requires the CommonJS provider. Both register the
same assertions from `contracts.cjs`, using injected synthetic HTTP/SSE responses
and a fake credential. No source or `dist` paths are imported and there is no
live transport fallback. Unexpected synthetic requests are recorded and fail.

## Historical coverage map

The release packet `vivi-core-0.17.0-release-packet-d4c4f83` contains seven behavior
cases in `fixtures/openai-contracts.cjs`, registered by `openai-installed.mjs` and
`openai-installed.cjs`. Its `evidence/node22-exact-tar-consumer.log` and
`evidence/node24-exact-tar-consumer.log` record fourteen passes: seven per module
format. These are historical evidence, not results for the current candidate.
All original assertions are retained in the shared fixture. The following table
maps each historical TAP case number to its permanent behavior, including the
assertions inside parameterized cases.

| Historical case | Mode | Permanent case in `contracts.cjs` | Behavioral assertions retained |
| --- | --- | --- | --- |
| 1 | CJS | projection has exact estimate/wire parity without resolving credentials during estimation | Exact projected prompt estimate equals the sent body; estimation resolves no key and sends no request; generation resolves the key once; callback captured at construction despite later option replacement; system becomes developer; tools become namespaced; output cap removed; purpose stays host-only; caller input unchanged. |
| 2 | CJS | projection body is detached from canonical tool schemas and fixed reasoning configuration | Estimate and send cannot mutate nested caller schema; every callback starts with captured high reasoning; only the sent schema receives the projection edit. |
| 3 | CJS | unsupported projections reject before HTTP without leaking their thrown details | Changed model, changed stream, undefined field, null result and thrown callback all reject in estimate/send; generation uses the public error class; thrown detail is sanitized; no HTTP. |
| 4 | CJS | default API-key request encoding remains flat, nonstreaming and output-bounded | Default Responses URL, bearer header, system role, flat function tools with strict false, stream/store false, output cap, encrypted reasoning include and absence of unconfigured reasoning. |
| 5 | CJS | HTTP and terminal SSE errors retain opt-in status/code/param/requestId, not raw secrets | HTTP 429 and terminal SSE failure at HTTP 200 retain exact safe code, param, request ID and error shape; public error class/status; frozen details; no cause, raw message or fake key in serialized error/message; one request per failure. |
| 6 | CJS | diagnostics are opt-in and preserve detail/unreadable/other body shape without raw values | Detail JSON, malformed JSON and other JSON classify without retaining private values; default diagnostics disabled even when a safe upstream code exists; HTTP status preserved. |
| 7 | CJS | bearer-bearing, nonidentifier and oversized diagnostic fields are safely omitted | Fake key, slash, whitespace and 201-character fields are omitted from code, param and request ID; error shape retained; raw detail/key absent. |
| 8 | ESM | projection has exact estimate/wire parity without resolving credentials during estimation | Same complete assertion set as case 1, through the public ESM export. |
| 9 | ESM | projection body is detached from canonical tool schemas and fixed reasoning configuration | Same complete assertion set as case 2, through the public ESM export. |
| 10 | ESM | unsupported projections reject before HTTP without leaking their thrown details | Same complete assertion set as case 3, through the public ESM export. |
| 11 | ESM | default API-key request encoding remains flat, nonstreaming and output-bounded | Same complete assertion set as case 4, through the public ESM export. |
| 12 | ESM | HTTP and terminal SSE errors retain opt-in status/code/param/requestId, not raw secrets | Same complete assertion set as case 5, through the public ESM export. |
| 13 | ESM | diagnostics are opt-in and preserve detail/unreadable/other body shape without raw values | Same complete assertion set as case 6, through the public ESM export. |
| 14 | ESM | bearer-bearing, nonidentifier and oversized diagnostic fields are safely omitted | Same complete assertion set as case 7, through the public ESM export. |

The shared assertion organization is unchanged. Only the wrapper and support file
names change. Each wrapper registers eleven cases: the seven historical cases and
four added cases below, for 22 runtime cases when both wrappers run. Inner loops
exercise several failure variants without inflating the top-level case count.

| Added case, in both runtime formats | Additional regression protected |
| --- | --- |
| throwing and rejected projections isolate mutations and allow later successful calls | Throw, changed identity and non-JSON rejection after nested schema, message and reasoning edits; both estimate/send leave caller/configuration unchanged and send nothing; projection never receives credentials; later estimate/send on the same provider recover with original input/reasoning and exact estimate/wire parity. |
| asynchronous and cyclic projection results reject before transport | Runtime rejects resolved Promise and cyclic results as non-JSON in both estimate/send, preserving caller input and making no request. |
| diagnostic identifiers accept the 200-character boundary and omit unsafe fields independently | HTTP and terminal SSE retain 200-character identifiers; empty, nonstring, newline, embedded fake key and 201-character params are omitted without removing independent safe code/request ID. |
| oversized HTTP diagnostic bodies are canceled and retain only safe bounded metadata | A body over 65,536 bytes is canceled, keeps HTTP 503 and safe request ID with unreadable shape, and retains no raw detail, key or cause. The stream stays open until canceled, so this also detects an unbounded reader. |

## Strict installed declarations

`types.mts` imports public ESM declarations; `types.cts` uses CommonJS import
assignments. Both preserve the historical synchronous JSON transform, async key
resolver, boolean diagnostics opt-in, `ModelProvider` compatibility, public
`ProviderRequestError` status/details, closed body-shape union and readonly captured
diagnostics checks. Negative checks reject async transforms, invalid opt-in values,
unknown body shapes and diagnostic mutation. Additional checks reject undefined
projection fields and a string output cap, and compile typed estimate/send calls
with host purpose and async text progress. These are compile-only consumers; their
expected-error expressions must never be executed as runtime fixtures.

## A3 registration contract and integration status

A2 accepts the coordinator-approved version 1 entry point
`test/package-contracts/manifest.json`. A2 owns this fixture manifest; A3 owns the
shared runner registration. The manifest is included in this candidate, with an
external A2 integration proposal recording the handoff. Its runtime entries are
`runtime.mjs` and `runtime.cjs`; type entries are `types.mts` and `types.cts`.
The whole directory must be copied into the clean installed consumer, including
the sibling `contracts.cjs` support file, before running the entries.

The A3 portable full command `npm run test:package:built` executes these runtime
entries and strict declaration consumers against the actual packed candidate
installed in a fresh temporary consumer. The bounded smoke command
`node scripts/test-package-smoke.mjs` preserves its existing 17-export checks
only; it does not execute the A2 fixtures. `npm run test:package` first
builds and then uses the full installed harness. Existing public export checks and
consumer assertions remain in place. A3 owns lifecycle, portable argv spawning,
timeouts, propagation of fixture failures and exact archive SHA256 capture.
The approved A3 runner invokes TypeScript from repository tooling against each
type fixture copied into the clean consumer; package declarations resolve from
that consumer's installed package. Each file is compiled separately with:

```text
--strict --noEmit --module NodeNext --target ES2022 --lib ES2022,DOM <consumer>/package-contracts/types.mts
--strict --noEmit --module NodeNext --target ES2022 --lib ES2022,DOM <consumer>/package-contracts/types.cts
```

Runtime entries use Node's `node:test` registration and fail the process on any
failed assertion, whether invoked directly or through `node --test`. A3's full
harness propagates nonzero fixture exit status. The final A3 dependency
`632acaad2ebcebbd9f88d90fbf08d72f1460ed55` requires the manifest whenever the
fixture directory exists, and a malformed present manifest fails. Only absence
of the entire fixture directory permits the pre-integration skip.

This bounded candidate adds only fixtures, their fixture manifest and this map;
it does not edit harnesses, CI, package manifests/lockfiles, exports or release
records. It has no new installed pass until a leased validation records the
packed candidate hash. Historical
packet passes and A3's harness-only passes do not establish that these fixture
bytes have run. Mac native smoke remains separately assigned.
