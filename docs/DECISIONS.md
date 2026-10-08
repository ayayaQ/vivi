# Optional decision review

This module is published in verified stable `0.7.0` and absent from immutable `0.6.0`.
Exact registry bytes and clean Node 22/24 consumers are verified; see the
[release record](../RELEASING.md). Host adoption remains a separate reviewed change.

Import `@ayayaq/vivi/decisions` for frozen review requests, fail-closed normalization,
and dedicated OpenAI/OpenRouter decision providers. The existing agent loop and generation
providers are unchanged. Nothing in this module executes tools, grants permissions,
reads files, saves credentials, opens an approval UI, or writes audit logs.

This first version supports text/JSON evidence and named predicate requirements only.
It does not expose image, choice, score, generated explanation, or reasoning-trace APIs.
The providers use the dedicated Decisions endpoints, not Responses or Chat Completions.

## Host responsibilities

Before using a provider, the host must validate and prepare the exact tool call, apply
hard policy, and decide whether this particular action is eligible for model review.
Hard denials and mandatory-human actions remain outside model authority. This module
does not define Discord, filesystem, subprocess, account, spending, or other host rules.

An `allow` result is a recommendation about the supplied evidence. It supplies no sandbox
or execution permission. Before any commit, the host must recheck hard rules, eligibility,
run cancellation, account/toolset state, prepared mutation, validation result, and resource
revisions. If no human review channel is available, an `ask` cannot silently become `allow`.
The host should start in shadow/manual mode and evaluate labeled, adversarial examples
before enabling automatic approval for a narrowly defined eligible action class.

## Frozen request

`createDecisionRequest(snapshot, policy)` synchronously copies and deeply freezes plain
JSON. Use the current user-authored request and approved scope, not the acting model's
description of its intent. A snapshot includes:

- `sessionId`, `runId`, and `toolCall.id`, `toolCall.name`, exact `toolCall.arguments`
- `userRequest.id`, `userRequest.text`, and `userRequest.approvedScope`
- `policyRevision` and host-authored `resourceRevisions`
- `inputData`, which is separate untrusted evidence

Include relevant prepared before/after digests, validation report/candidate/fixture hashes,
base resource revisions, toolset revision, and opaque account identity revision in
`resourceRevisions`. Never include credentials or authentication tokens there. Digests
supplement the exact argument snapshot; they do not replace it.

The combined snapshot and policy are limited to 65,536 UTF-8 bytes, depth 32, and 16 checks.
The wire request and response are separately limited to 65,536 bytes. No truncation occurs.
Oversized or incomplete evidence must stay in the host's manual path. Cycles, accessors,
custom prototypes, sparse arrays, non-JSON values (including negative zero), extra schema fields, and invalid
thresholds throw sanitized `DecisionConfigurationError` before a provider request.

`isDecisionCurrent(result, currentSnapshot)` recognizes results produced by this module
and compares the entire captured snapshot, including all arguments, scope and revisions.
Object-key order is immaterial; array order and every JSON value remain significant.
It does not check external state by itself, detect changes absent from the snapshot,
expire or consume results, or grant permission. The host must avoid replay by tracking the
pending call's lifecycle, marking it consumed after execution, and atomically rechecking
current state plus committing under its own lock or compare-and-swap. Any policy/question/
threshold change must update `policyRevision`; relevant account/toolset/resource changes
must update the corresponding snapshot revisions.
Results have process-local binding: serializing, cloning, or reconstructing a result removes
that binding. Do not persist a recommendation and later treat it as an approval token.

## Prepared-action routing (prepared 0.8.0)

The optional `DecisionSnapshot.preparedAction` field and `routePreparedAction(snapshot)`
helper are prepared for `0.8.0`, not yet published and absent from immutable `0.7.0`.
Host adoption remains separately reviewed. Snapshots without this field keep the existing
Decisions behavior; the new helper routes them to `manual` with `missing_metadata`.

Use one exact snapshot for preparation, routing, review, and the host's commit-time
comparison. The existing `createDecisionRequest` copies and deeply freezes this metadata
along with the tool call, approved scope, input data, and revisions. Routing also accepts
`request.snapshot`; it is synchronous, performs no provider request, and returns only a
frozen `{ route, reasonCode }`. No second request or permission token is created.

Trusted host code must resolve concrete resource identities and enumerate every effect:

- `complete`: true only when preparation accounts for all effects, targets, and affected data
- `effects`: up to 256 entries, each with `kind` (`read`, `write`, `external`, or `unknown`)
- `resourceId`: an exact opaque host-resolved identity, with an own entry in `resourceRevisions`
- `scope`: host-classified `workspace`, `outside-workspace`, `external`, or `unknown`
- `affectedData`: exact affected selection/content or prepared before/after evidence, as JSON
- `review`: trusted host classification: `ordinary-read`, `model-review`, `manual`, or `blocked`

`ordinary-read` asserts that this effect is a permitted, non-sensitive ordinary workspace
read. Mere readability or workspace membership is insufficient. `model-review` asserts
that hard host policy permits the effect and model review is eligible; `manual` and
`blocked` preserve mandatory human review and hard denials. Provider destination and
exact-data transmission permission still require the host's separate privacy checks.
The acting model, retrieved content, or review model cannot supply these classifications.
Do not pass model-generated metadata directly to the helper.

Routing uses every effect, without guessing from tool names, descriptions, user prose,
arguments, or path patterns:

- Any `blocked` effect: `blocked`; otherwise any `manual` effect: `manual`
- Incomplete or empty effects, unknown kind/scope: `manual`
- `ordinary-read` paired with anything except `read` + `workspace`: `manual`
- Every effect explicitly `ordinary-read` + `read` + `workspace`: `auto-read`
- Remaining known effects, each explicitly ordinary-read or model-review eligible: `model-review`

A mixed read/write or external-effect call never becomes an automatic read. Known mixed
effects may receive model review only when every effect is eligible. Missing revisions,
invalid metadata, and malformed snapshots produce `manual` / `invalid_snapshot` from
routing; `createDecisionRequest` rejects them with sanitized `DecisionConfigurationError`.
Existing JSON depth/byte limits apply, with no truncation. Results contain no targets or data.

The helper does not resolve a path, inspect a filesystem, enroll a root, verify content,
grant external workspace access, open approval UI, or execute anything. A revision entry
captures host evidence; it does not prove current content or access. For unversioned targets,
the host must capture whatever concrete identity/state evidence its own commit checks need.
Hosts retain validation, target resolution, sandbox/access rules, cancellation, privacy,
one-time lifecycle, and atomic current-state recheck plus commit. Even `auto-read` is routing,
not new access authority; a model recommendation cannot broaden existing permissions.

Both adapters include this metadata under `hostState.preparedAction` in the structured
evidence envelope. `affectedData` remains evidence, never question instructions or approval.
`isDecisionCurrent` binds its exact values, classifications, resource identities, and
revisions; changing any of them invalidates the captured result. Changes absent from the
snapshot cannot be detected by this library.

## Named requirements and provider-specific thresholds

A policy contains `provider: 'openai' | 'openrouter'` and `checks`. Each check has:

- A unique ASCII `name` matching `[A-Za-z][A-Za-z0-9_]{0,63}`
- Host-authored `instructions`, `trueDescription`, and `falseDescription`
- Required `allowAt`, with `0 < allowAt <= 1`
- Optional `denyAt`, with `0 <= denyAt < allowAt`

Every question is a requirement that should be true. Express prohibitions as appropriate
requirements (for example, "the destination is within the user's approved scope").
Keep host policy in the questions. Tool arguments, retrieved content, and other evidence
must never write policy, invent an approval, select an endpoint, or supply credentials.
The adapters keep a structured evidence envelope separate from the question instructions:
`userRequest`, `proposedToolCall`, `hostState`, and `untrustedInputData`.

The module supplies no default approval thresholds. Calibrate each provider separately
against the host's labeled examples and failure costs. Matching numeric thresholds across
OpenAI and Jev do not establish equivalent behavior or safety. Probability is a model
estimate; it is not proof of authorization or discovery of hidden effects.

All answers must be present, unique, named as requested, correctly typed, and finite within
`[0,1]`. For valid complete answers:

- All checks at or above `allowAt`: `allow`, reason `requirements_met`
- Any check at or below its configured `denyAt`: `deny`, reason `provider_recommended_reject`
- Otherwise: `ask`, reason `uncertain`

`deny` is a model recommendation, not a hard-policy rejection. The host decides whether
an ordinary one-time human approval remains permitted. Missing/unknown answers, malformed
output, refusal, unsupported models, invalid usage, and provider failures always produce
`ask`. Never reinterpret a transport failure as rejection or approval.

## Providers and cancellation

Both factories accept `{ apiKey, timeoutMs?, fetch? }`. `apiKey` may be a string or an
asynchronous host-owned resolver. Keys are used only for the official Authorization header
and are never retained in result/error objects or logs. There is no credential persistence.
`fetch` supports offline tests; it is a host-controlled transport, not request data.

- `createOpenAIDecisionProvider`: fixed `https://api.openai.com/v1/decisions`, `gpt-6-luna`
- `createOpenRouterDecisionProvider`: fixed `https://openrouter.ai/api/alpha/decisions`,
  `typesafe/jev-1.13`, with routing `allow_fallbacks: false`

Unknown options, including configurable model or base URL, are rejected. The documented
OpenRouter response identity `typesafe/jev-1.13-20260917` is also recognized; unknown model
identities fail closed. Model capability changes require a reviewed adapter update.
There are no retries, cross-provider fallbacks, streaming callbacks, or generated reasons.
Redirects are rejected so credentials cannot follow a redirected destination.

`evaluateDecision(request, provider, { signal?, timeoutMs? })` has a 10-second default
end-to-end deadline, including custom providers. Built-in providers also have an independently
configurable 10-second transport deadline. Deadlines cover credential resolution, fetch,
body reading, and synchronous parsing boundaries. Aborted/deadline-exceeded late output is
discarded even if a transport or custom provider ignores its signal.

Cancellation returns `ask` with reason `aborted`. This is a terminal cancellation: suppress
manual approval prompts and never commit it. Timeout returns `ask` with reason `timeout`;
an active host run may offer manual review. The host must recheck cancellation after awaiting
the result and again before execution. External side effects cannot be undone by aborting
this review, so none should begin before the host has its actual execution authority.

Results contain only an outcome, standardized reason code, bounded named check results,
provider/model identity, normalized usage, and HTTP status when applicable. No raw request,
raw provider response, provider ID strings, arbitrary error message/cause, credentials,
free-form explanation, or hidden reasoning is returned. Reason codes distinguish `http`,
`rate_limit` (429), `transport`, `timeout`, `aborted`, configuration/schema failures, and refusal.
Provider usage is mandatory; the module never synthesizes absent accounting as zero.

## Privacy and testing

The exact snapshot is sent to the selected provider. OpenRouter also routes it to TypeSafe.
The host must authorize the destination/data, minimize evidence, and exclude secrets,
unnecessary private content, and hidden reasoning before creating a review request. If exact
arguments contain data that cannot be shared, keep the call in the manual path; do not redact
arguments into a different call and then treat a model recommendation as permission for the
original. No remote-storage or retention guarantees are implied by this library.

Audit policy belongs to the host. Log only authorized, privacy-safe metadata and coded
reasons. Neither requests nor full argument snapshots are safe default log material.

`examples/decisions.mjs` runs entirely offline with a mock provider and performs no tool
execution. Unit tests use synthetic HTTP fixtures, fake credentials, and ignored-abort/late
output cases. They verify protocol parsing and non-execution fallbacks, not model accuracy,
calibration, latency promises, real account access, or end-to-end host approval UX.

## Protocol sources

Wire shapes were checked on October 7, 2026 against these primary references:

- [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions)
- [OpenAI create-decision reference](https://developers.openai.com/api/reference/resources/decisions/methods/create)
- [OpenRouter Decisions reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)
- [Jev on OpenRouter](https://openrouter.ai/docs/guides/community/jev)
- [Jev tool-gating cookbook](https://openrouter.ai/docs/cookbook/building-agents/gate-tool-calls-with-jev)

OpenAI maps predicates to a `questions` array and receives an `answers` array of predicates
or refusals. Jev maps predicates to named `noul` questions and a named answers object. The
shared normalizer unifies numeric predicate estimates without assuming calibrated equivalence.
