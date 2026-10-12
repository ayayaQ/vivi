// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto'
import type { ToolExtension } from '../extensions.js'
import type { JsonObject, ToolResult } from '../types.js'
import { assert, assertJson, record } from '../validation.js'

export const QUESTION_LIMITS = Object.freeze({
  questions: 3,
  options: 3,
  idCharacters: 64,
  headerCharacters: 24,
  questionCharacters: 1_000,
  labelCharacters: 100,
  descriptionCharacters: 500,
  answerCharacters: 4_000
})

export interface QuestionOption {
  readonly id: string
  readonly label: string
  readonly description?: string
}

/** Other/free text and skip are host actions, never model-supplied options. */
export interface Question {
  readonly id: string
  readonly header: string
  readonly question: string
  /** Omit for a free-text question; when present, supply 2–3 choices. */
  readonly options?: readonly QuestionOption[]
}

/** A single live prompt, bound to the executing tool call and its host/run lifetime. */
export interface QuestionRequest {
  readonly requestId: string
  readonly callId: string
  readonly questions: readonly Question[]
}

export type QuestionAnswer =
  | { readonly kind: 'option'; readonly optionId: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'skipped' }

export interface QuestionAnswerEntry {
  readonly id: string
  readonly answer: QuestionAnswer
}

export type QuestionResponse =
  | { readonly requestId: string; readonly status: 'answered'; readonly answers: readonly QuestionAnswerEntry[] }
  | { readonly requestId: string; readonly status: 'cancelled' }

/**
 * The host must collect genuine human input and bind it to this exact request. It owns UI,
 * focus, and a shared queue with action-approval dialogs. On abort, invalidate and dismiss
 * the prompt; never apply a default choice or allow a stale answer into another run.
 * Responses carry information only, and grant no action, permission, or decision authority.
 */
export type QuestionHost = (
  request: QuestionRequest,
  context: { readonly signal: AbortSignal }
) => QuestionResponse | Promise<QuestionResponse>

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  assert(Object.keys(value).every((key) => allowed.includes(key)), 'Unexpected question field')
}

function text(value: unknown, maximum: number, field: string): asserts value is string {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum,
    `${field} must contain 1..${maximum} characters of nonblank text`)
}

function id(value: unknown, field: string): asserts value is string {
  assert(typeof value === 'string' && value.length <= QUESTION_LIMITS.idCharacters &&
    /^[A-Za-z0-9_-]+$/.test(value), `${field} must be a 1..64 character identifier`)
}

function assertQuestions(arguments_: Readonly<JsonObject>): void {
  assertJson(arguments_)
  keys(arguments_, ['questions'])
  const questions = arguments_.questions
  assert(Array.isArray(questions) && questions.length >= 1 && questions.length <= QUESTION_LIMITS.questions,
    'questions must contain 1..3 questions')
  const ids = new Set<string>()
  for (const question of questions) {
    assert(record(question), 'Question must be an object')
    keys(question, ['id', 'header', 'question', 'options'])
    id(question.id, 'Question id')
    assert(!ids.has(question.id), 'Question ids must be unique')
    ids.add(question.id)
    text(question.header, QUESTION_LIMITS.headerCharacters, 'Question header')
    text(question.question, QUESTION_LIMITS.questionCharacters, 'Question text')
    if (Object.hasOwn(question, 'options')) {
      const options = question.options
      assert(Array.isArray(options) && options.length >= 2 && options.length <= QUESTION_LIMITS.options,
        'Question options must contain 2..3 choices or be omitted')
      const optionIds = new Set<string>()
      const labels = new Set<string>()
      for (const option of options) {
        assert(record(option), 'Question option must be an object')
        keys(option, ['id', 'label', 'description'])
        id(option.id, 'Option id')
        assert(!optionIds.has(option.id), 'Option ids must be unique within a question')
        optionIds.add(option.id)
        text(option.label, QUESTION_LIMITS.labelCharacters, 'Option label')
        assert(!labels.has(option.label.trim()), 'Option labels must be distinct within a question')
        labels.add(option.label.trim())
        if (Object.hasOwn(option, 'description')) {
          text(option.description, QUESTION_LIMITS.descriptionCharacters, 'Option description')
        }
      }
    }
  }
}

function captureResponse(value: unknown, request: QuestionRequest): QuestionResponse {
  assertJson(value)
  assert(record(value), 'Question response must be an object')
  assert(value.requestId === request.requestId, 'Question response must match the active requestId')
  if (value.status === 'cancelled') {
    keys(value, ['requestId', 'status'])
    return { requestId: request.requestId, status: 'cancelled' }
  }
  keys(value, ['requestId', 'status', 'answers'])
  assert(value.status === 'answered', 'Question response status must be answered or cancelled')
  assert(Array.isArray(value.answers) && value.answers.length === request.questions.length,
    'Question response must explicitly answer or skip every question')
  const answers = new Map<string, QuestionAnswer>()
  for (const entry of value.answers) {
    assert(record(entry), 'Question answer must be an object')
    keys(entry, ['id', 'answer'])
    id(entry.id, 'Answer id')
    const question = request.questions.find((question) => question.id === entry.id)
    assert(question && !answers.has(entry.id), 'Question answer id must uniquely match a requested question')
    const answer = entry.answer
    assert(record(answer), 'Question answer value must be an object')
    if (answer.kind === 'option') {
      keys(answer, ['kind', 'optionId'])
      assert(question.options?.some((option) => option.id === answer.optionId),
        'Selected option must match a choice for this question')
      answers.set(entry.id, { kind: 'option', optionId: answer.optionId as string })
    } else if (answer.kind === 'text') {
      keys(answer, ['kind', 'text'])
      text(answer.text, QUESTION_LIMITS.answerCharacters, 'Answer text')
      answers.set(entry.id, { kind: 'text', text: answer.text })
    } else {
      keys(answer, ['kind'])
      assert(answer.kind === 'skipped', 'Question answer kind must be option, text, or skipped')
      answers.set(entry.id, { kind: 'skipped' })
    }
  }
  return {
    requestId: request.requestId,
    status: 'answered',
    answers: request.questions.map(({ id }) => ({ id, answer: answers.get(id)! }))
  }
}

/** Stop waiting promptly even when a trusted host ignores cancellation. Observe late rejection. */
function wait<T>(operation: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      callback()
    }
    const abort = (): void => finish(() => reject(signal.reason))
    signal.addEventListener('abort', abort, { once: true })
    // The caller can abort before this microtask admits the operation.
    void Promise.resolve().then(() => {
      signal.throwIfAborted()
      return operation()
    }).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    )
  })
}

/**
 * Opt-in, renderer-neutral clarification tool. Create it with a run/owner-bound host callback
 * and register through that owner's ExtensionScope. No host means no advertised tool.
 * Sharing an instance serializes its question calls; separate host instances must share their
 * own UI queue. Disposing the scope aborts active and queued calls through the existing bridge.
 */
export function createQuestionExtension(options: { readonly ask?: QuestionHost } = {}): ToolExtension {
  assert(record(options), 'Question extension options must be an object')
  keys(options, ['ask'])
  const ask = options.ask
  assert(ask === undefined || typeof ask === 'function', 'Question host ask must be a function')
  let tail = Promise.resolve()
  const extension: ToolExtension = {
    id: 'vivi.questions',
    apiVersion: 1,
    tools: ask ? [{
      definition: {
        name: 'request_user_input',
        description: 'Ask the user 1–3 clarification questions. They may select a choice, enter text, skip, or cancel. Answers do not approve tools or authorize actions.',
        parameters: {
          type: 'object',
          properties: {
            questions: {
              type: 'array', minItems: 1, maxItems: QUESTION_LIMITS.questions,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', minLength: 1, maxLength: QUESTION_LIMITS.idCharacters, pattern: '^[A-Za-z0-9_-]+$' },
                  header: { type: 'string', minLength: 1, maxLength: QUESTION_LIMITS.headerCharacters },
                  question: { type: 'string', minLength: 1, maxLength: QUESTION_LIMITS.questionCharacters },
                  options: {
                    type: 'array', minItems: 2, maxItems: QUESTION_LIMITS.options,
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', minLength: 1, maxLength: QUESTION_LIMITS.idCharacters, pattern: '^[A-Za-z0-9_-]+$' },
                        label: { type: 'string', minLength: 1, maxLength: QUESTION_LIMITS.labelCharacters },
                        description: { type: 'string', minLength: 1, maxLength: QUESTION_LIMITS.descriptionCharacters }
                      },
                      required: ['id', 'label'], additionalProperties: false
                    }
                  }
                },
                required: ['id', 'header', 'question'], additionalProperties: false
              }
            }
          },
          required: ['questions'], additionalProperties: false
        }
      },
      validateArguments: assertQuestions,
      async execute(call, { signal }): Promise<ToolResult> {
        signal.throwIfAborted()
        // Also validate direct extension dispatch, not only registry-managed calls.
        assertQuestions(call.arguments)
        const request: QuestionRequest = freeze({
          requestId: randomUUID(),
          callId: call.id,
          questions: structuredClone(call.arguments.questions) as unknown as Question[]
        })
        const previous = tail
        let release!: () => void
        const completion = new Promise<void>((resolve) => { release = resolve })
        tail = previous.then(() => completion)
        try {
          await wait(() => previous, signal)
          signal.throwIfAborted()
          const response = await wait(() => ask(request, Object.freeze({ signal })), signal)
          signal.throwIfAborted()
          return { content: JSON.stringify(captureResponse(response, request)) }
        } finally {
          // Cancellation releases the slot even if the host promise never settles.
          release()
        }
      }
    }] : []
  }
  return freeze(extension)
}
