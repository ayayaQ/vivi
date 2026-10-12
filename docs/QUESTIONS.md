# Optional clarification question extension (prepared 0.12.0)

`@ayayaq/vivi/extensions/questions` is an opt-in, renderer-neutral v1 `ToolExtension`.
It has no terminal, desktop, DOM, provider, persistence or decision-service dependency.
The main loop and default tools remain unchanged. This extension is prepared for `0.12.0`,
not yet published, and absent from published `0.11.0`.

## API

```ts
import { createQuestionExtension } from '@ayayaq/vivi/extensions/questions'
import type {
  Question, QuestionOption, QuestionRequest, QuestionHost,
  QuestionAnswer, QuestionAnswerEntry, QuestionResponse
} from '@ayayaq/vivi/extensions/questions'

const extension = createQuestionExtension({ ask: hostAsk })
```

`ask` is optional. Omitting it returns an empty tool pack with id `vivi.questions` and
`apiVersion: 1`. A headless/noninteractive host should omit the callback, so the provider never
sees an unavailable capability. Do not supply a callback that waits for UI the host cannot show.
No guidance text or fallback/default answer is installed.

The registered tool is `request_user_input`:

```json
{
  "questions": [{
    "id": "format",
    "header": "Format",
    "question": "How should the plan be presented?",
    "options": [
      { "id": "checklist", "label": "Checklist", "description": "A short sequence of steps" },
      { "id": "prose", "label": "Prose", "description": "A concise explanation" }
    ]
  }]
}
```

Supply 1–3 questions with distinct ids. Each question has nonblank header and question text.
Options may be omitted for a free-text question; when supplied there must be 2–3 distinct
ids and distinct trimmed labels. Other/free text and skip are intrinsic host actions, so do
not add synthetic Other/Skip choices. Host renderers may show recommendations in labels,
but must not submit a highlighted/recommended option without human selection.

`QUESTION_LIMITS` exports the fixed bounds. Lengths use JavaScript UTF-16 code units:

- Question/option ids: 1–64 ASCII letters, digits, underscore or hyphen; case-sensitive
- Header: 1–24 characters; question: 1–1,000 characters
- Option label: 1–100 characters; optional description: 1–500 characters when present
- Free-text answer: 1–4,000 characters

Nonblank text is required; visible text and leading/trailing whitespace are preserved.
Unknown fields, duplicate ids, unknown options and non-JSON values are rejected.

## Host bridge and results

`ask(request, { signal })` receives a deeply frozen `QuestionRequest` with:

- A new UUID `requestId` for this dispatch, including when a call id is reused in another run
- The `callId` supplied by the agent runner
- A bounded, frozen copy of the exact questions the provider requested

It resolves only after human input or explicit dismissal, returning one of:

```ts
{ requestId: request.requestId, status: 'answered', answers: [
  { id: 'format', answer: { kind: 'option', optionId: 'checklist' } }
] }
{ requestId: request.requestId, status: 'answered', answers: [
  { id: 'format', answer: { kind: 'text', text: 'A short checklist' } }
] }
{ requestId: request.requestId, status: 'answered', answers: [
  { id: 'format', answer: { kind: 'skipped' } }
] }
{ requestId: request.requestId, status: 'cancelled' }
```

An answered response must explicitly answer or skip every requested question. The host may
return the entries in any order; the extension validates and orders the tool result by the
original questions. An option answer must name an option for that same question. Free text is
allowed with or without choices. Empty text is invalid; skip uses its own explicit kind.
Cancel applies to the whole prompt, contains no answers, and invents no default selections.

The result's `content` is JSON of the validated `QuestionResponse`. Explicit skip/cancel are
normal tool results, without `isError`. Invalid tool arguments become the existing registry's
`invalid_arguments`; a thrown host error or invalid/mismatched response becomes `tool_error`.
Runtime abort propagates cancellation through the runner/scope rather than becoming a fabricated
human response. Existing interrupted-history recovery closes unfinished calls as unknown outcomes.
Never replay an old prompt or restore its response as a new user decision.

## Ownership, concurrency and cancellation

Create the callback for the current host owner/run, not a process-global prompt slot. Register
the extension through the existing `createExtensionScope`, snapshot for the active run and
dispose the scope when that owner/run ends. Call it with the active run's `AbortSignal`.
The scope combines run cancellation and owner shutdown, sealing retained snapshots.
Request ids alone are correlation data, not lifetime checks or authentication.

One extension serializes concurrent question dispatch FIFO. Queued cancellation never displays
a prompt. Active cancellation stops waiting promptly, releases the queue and ignores any late
host response/rejection, even if the trusted callback does not cooperate. Cancellation does not
forcibly close host UI: the callback must immediately invalidate and dismiss its prompt when
`signal` aborts and never let stale input satisfy a different request. Multiple instances must
coordinate their shared UI themselves. Bind each renderer response to the request id, call id
and its still-live owner/run before resolving the callback.

Share a single host interaction queue with action-approval dialogs. Do not show competing
question and approval prompts or route input by whichever dialog happens to have focus.
The host must isolate answers from its approval-state and execution-admission APIs. No default
answer, timeout answer, auto-review service or agent-written response substitutes for human input.

## Questions are separate from approvals

The tool supplies ordinary clarification data only. It grants no permission and never returns
`allow`, `approve`, a decision token, or a mode transition. Even the free-text answer "yes" is
not an authorization to execute an action. Tool approvals must use the host's separate exact-action
review flow. Selecting a choice cannot enable Auto mode, broaden eligibility, accept a plan for
execution, clear a policy block, or manufacture an approval.

Hosts may offer this informational tool in both normal and Plan mode when interactive UI is
available. Plan-mode tool allowlists can classify it explicitly as clarification while retaining
their read-only restrictions. The extension does not classify or execute any other tool and
does not weaken those restrictions. A later UI adoption must test repeated prompts, queued
approval collisions, skip/cancel/close, run interruption, owner changes and stale responses.

## Offline evidence and adoption

`examples/questions.mjs` supplies clearly labelled synthetic input. Unit tests and paired
CLI/Desktop-shaped mocks cover choices, text, skip/cancel, validation, immutable request/result
copies, current-request binding, FIFO waits and owner/run cancellation. Packaged ESM/CommonJS
and strict NodeNext consumers cover runtime exports and declarations. These fixtures verify the
shared contract; they do not constitute production CLI/Desktop UI adoption or real-model tests.

Version `0.12.0` is prepared; npm publication is still pending. Adopt through a separate reviewed
host change only after that version is published and its registry package is verified.
