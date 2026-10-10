# Tool presentation (CORE-13)

Prepared `0.11.0` adds optional `@ayayaq/vivi/presentation`, absent from published `0.10.0`.
It imports no runtime modules or UI frameworks and works in a browser renderer.
It is display-only: hosts own privacy screening, exact call/run binding, approvals, tool
execution, persistence and outcome evidence. A snapshot, source reference, result, warning
or saved approval text supplies no authority. No URL is fetched or opened.

## Contract

Prepare the complete host-verified `ToolPresentation` data, privacy-screen it, serialize it
as JSON, then call `decodeToolPresentation(encoded)`. The decoder accepts a primitive
string, validates bounded version-1 data and returns a detached, deeply frozen snapshot.
Only decoded snapshots can be rendered; re-decode data after JSON/IPC/persistence transfer.
No caller object, getter, iterator or `toJSON` callback is evaluated by the decoder.

- Required identity: `callId`, `name`, source `reference` and optional `revision`
- Required status: requested, approval_required, running, succeeded, denied, failed,
  cancelled or unknown; effect: not_attempted, confirmed, unknown or unreported
- Arguments and optional result: `{ kind, text, data? }`; `text` is the safe fallback
  for every unknown kind, `json` requires bounded JSON data, `text` forbids data
- Optional progress text and up to eight host-authored warnings

Statuses/effects are exact host facts, never inferred from generic `isError`, cancellation,
result JSON, source URLs or progress. A failed operation may have effects; a confirmed
response does not establish no effects. Old evidence without effects must say `unreported`.
This module does not resolve contradictory host evidence or replace CORE-12 record validation.

Bounds are 128 KiB UTF-8 wire data, 16 KiB arguments and 64 KiB result sections (including
their metadata/fallback text), 4,096 JSON nodes and depth 16. Identity/source/progress/warning
fields have separate small limits. Oversized/invalid input is rejected, never silently relabeled
as success. Hosts must show their own safe error when decoding fails, rather than drop a card.

`toolPresentationView(snapshot, { collapsed?, detailBytes? })` returns separate always-visible
`header` and `warnings`, optional detail rows and a collapse/truncation notice. Status, effect,
source/revision, progress, approval-required/denied/failed/unknown warnings and host warnings
never consume the shared detail budget, including a zero-byte budget. Unknown kinds show their
text fallback (or a fixed no-details notice), with an always-visible unsupported-kind warning;
their structured data is never interpreted. Known JSON is rendered in canonical key order.

`renderToolPresentationText` joins the same view for terminals/logs. Terminal and bidi controls
are escaped; detail clipping preserves UTF-8 characters. Treat all strings as inert text:
Svelte escaped interpolation, DOM textContent or plain terminal text, never HTML/Markdown/link
activation. Do not truncate the whole view/string, put its header/warnings inside `<details>`,
or subject them to a generic transcript/detail budget. Whole-history retention is host-owned.

## Actual consumer seams and fixtures

The owned offline fixtures model two distinct current layouts using identical semantic data:

- CLI main `0615163ffb2713c6148bed028f1317e2dd36c505`: [DisplayEntry/history and review
  notices](https://github.com/ayayaQ/vivi-cli/blob/0615163ffb2713c6148bed028f1317e2dd36c505/src/tui.ts#L1254-L1340),
  [live tool status](https://github.com/ayayaQ/vivi-cli/blob/0615163ffb2713c6148bed028f1317e2dd36c505/src/tui.ts#L1450-L1468)
  and [terminal tool output](https://github.com/ayayaQ/vivi-cli/blob/0615163ffb2713c6148bed028f1317e2dd36c505/src/terminal.ts#L369-L403)
- Desktop main `48d2c03a629a6f6d989f67387733b19c66dc7246`: [tool status/review header and
  collapsible result](https://github.com/ayayaQ/bot-commander-desktop/blob/48d2c03a629a6f6d989f67387733b19c66dc7246/src/renderer/src/components/AgentPanel.svelte#L605-L711),
  [MCP warnings outside details](https://github.com/ayayaQ/bot-commander-desktop/blob/48d2c03a629a6f6d989f67387733b19c66dc7246/src/renderer/src/components/AgentMcpOutcome.svelte),
  and [bounded result text](https://github.com/ayayaQ/bot-commander-desktop/blob/48d2c03a629a6f6d989f67387733b19c66dc7246/src/renderer/src/utils/agentMcpOutcome.ts)

`test/tool-presentation-hosts.test.mjs` covers request/approval/progress and CORE-12-style
success, denied, failed-confirmed, cancel-before-send and unknown-effect outcomes, expanded,
collapsed and truncated. These are small fixture consumers, not actual OpenTUI/Svelte tests
or production adoption. CLI-21/Desktop-15 remain independent adapters after reviewed publication.

Harness [UI-neutral slots](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-slots/README.md)
informed separating renderer contracts from host frameworks. No Harness code is copied and no
slot registry, component factory, store, subscription/event bus or plugin runtime is introduced.
Run `npm run check`; `examples/tool-presentation.mjs` is offline.
