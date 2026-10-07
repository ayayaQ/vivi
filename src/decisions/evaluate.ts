// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import { ProviderRequestError } from '../providers/transport.js'
import { canonical, copyJson, invalid, keys, MAX_DECISION_CHECKS, probability, record, text } from './validation.js'
import type {
  DecisionCheckResult, DecisionPolicy, DecisionProvider, DecisionProviderId, DecisionReasonCode,
  DecisionRequest, DecisionResult, DecisionSnapshot, DecisionUsage, EvaluateDecisionOptions
} from './types.js'

const requests = new WeakMap<DecisionRequest, string>()
const results = new WeakMap<DecisionResult, string>()

export function supportedModel(provider: DecisionProviderId, model: unknown): model is string {
  return provider === 'openai' ? model === 'gpt-6-luna' :
    model === 'typesafe/jev-1.13' || model === 'typesafe/jev-1.13-20260917'
}

/** Validate and freeze immediately, before key resolution, network work, or model evaluation. */
export function createDecisionRequest(snapshot: DecisionSnapshot, policy: DecisionPolicy): DecisionRequest {
  const copied = copyJson({ snapshot, policy })
  if (!record(copied) || !record(copied.snapshot) || !record(copied.policy)) invalid()
  const state = copied.snapshot
  if (!keys(state, ['sessionId', 'runId', 'toolCall', 'userRequest', 'policyRevision', 'resourceRevisions', 'inputData']) ||
      !text(state.sessionId, 256) || !text(state.runId, 256) || !text(state.policyRevision, 256) ||
      !record(state.resourceRevisions) || !record(state.toolCall) || !record(state.userRequest)) invalid()
  if (!keys(state.toolCall, ['id', 'name', 'arguments']) || !text(state.toolCall.id, 256) ||
      !text(state.toolCall.name, 256) || !record(state.toolCall.arguments)) invalid()
  if (!keys(state.userRequest, ['id', 'text', 'approvedScope']) || !text(state.userRequest.id, 256) ||
      !text(state.userRequest.text)) invalid()
  const config = copied.policy
  if (!keys(config, ['provider', 'checks']) || (config.provider !== 'openai' && config.provider !== 'openrouter') ||
      !Array.isArray(config.checks) || config.checks.length < 1 || config.checks.length > MAX_DECISION_CHECKS) invalid()
  const names = new Set<string>()
  for (const check of config.checks) {
    if (!record(check) || !keys(check, ['name', 'instructions', 'trueDescription', 'falseDescription', 'allowAt'], ['denyAt']) ||
        typeof check.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(check.name) || names.has(check.name) ||
        !text(check.instructions, 4_096) || !text(check.trueDescription, 2_048) || !text(check.falseDescription, 2_048) ||
        !probability(check.allowAt) || check.allowAt === 0 ||
        (check.denyAt !== undefined && (!probability(check.denyAt) || check.denyAt >= check.allowAt))) invalid()
    names.add(check.name)
  }
  const request = copied as unknown as DecisionRequest
  requests.set(request, canonical(copied.snapshot))
  return request
}

/** This compares evidence and revisions only; a true result is not a permission grant. */
export function isDecisionCurrent(result: DecisionResult, snapshot: DecisionSnapshot): boolean {
  const bound = results.get(result)
  if (bound === undefined) return false
  try { return canonical(copyJson(snapshot)) === bound } catch { return false }
}

function finish(request: DecisionRequest, result: DecisionResult): DecisionResult {
  const frozen = Object.freeze(result)
  const bound = requests.get(request)
  if (bound !== undefined) results.set(frozen, bound)
  return frozen
}

function fallback(request: DecisionRequest, reasonCode: DecisionReasonCode, provider?: DecisionProviderId, model?: string,
  httpStatus?: number, usage?: DecisionUsage): DecisionResult {
  return finish(request, {
    outcome: 'ask', reasonCode, checks: Object.freeze([]),
    ...(provider ? { provider } : {}), ...(model ? { model } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}), ...(usage ? { usage: Object.freeze({ ...usage }) } : {})
  })
}

export function validUsage(value: unknown): value is DecisionUsage {
  if (!record(value) || !keys(value, ['inputTokens', 'outputTokens'],
    ['totalTokens', 'cachedTokens', 'cacheWriteTokens', 'reasoningTokens', 'costUsd'])) return false
  for (const [key, count] of Object.entries(value)) {
    if (key === 'costUsd') { if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return false }
    else if (!Number.isSafeInteger(count) || (count as number) < 0) return false
  }
  return (value.totalTokens === undefined || value.totalTokens === (value.inputTokens as number) + (value.outputTokens as number)) &&
    (value.cachedTokens === undefined || (value.cachedTokens as number) <= (value.inputTokens as number)) &&
    (value.cacheWriteTokens === undefined || (value.cacheWriteTokens as number) <= (value.inputTokens as number)) &&
    (value.reasoningTokens === undefined || (value.reasoningTokens as number) <= (value.outputTokens as number))
}

/** All failures ask, except cancellation which asks as a terminal non-executing signal to the host. */
export async function evaluateDecision(
  request: DecisionRequest, provider: DecisionProvider, options: EvaluateDecisionOptions = {}
): Promise<DecisionResult> {
  if (!requests.has(request)) return fallback(request, 'invalid_request')
  let providerId: DecisionProviderId
  let model: string
  try {
    providerId = provider.id
    model = provider.model
    if (providerId !== 'openai' && providerId !== 'openrouter') return fallback(request, 'provider_mismatch')
    if (request.policy.provider !== providerId) return fallback(request, 'provider_mismatch', providerId)
    if (!supportedModel(providerId, model)) return fallback(request, 'unsupported_model', providerId)
    if (typeof provider.evaluate !== 'function') return fallback(request, 'configuration', providerId, model)
  } catch { return fallback(request, 'configuration') }
  let signal: AbortSignal | undefined
  let timeoutMs: number
  let externallyAborted = (): boolean => false
  try {
    if (!record(options) || !keys(options, [], ['signal', 'timeoutMs']) ||
        Reflect.ownKeys(options).some((key) => typeof key !== 'string' ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key)!, 'value'))) {
      return fallback(request, 'configuration', providerId, model)
    }
    const suppliedSignal = options.signal
    if (suppliedSignal !== undefined && !(suppliedSignal instanceof AbortSignal)) return fallback(request, 'configuration', providerId, model)
    if (suppliedSignal !== undefined) {
      // instanceof alone accepts objects that lack the native AbortSignal internal slots.
      const readAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
      readAborted.call(suppliedSignal)
      externallyAborted = () => readAborted.call(suppliedSignal) as boolean
    }
    signal = suppliedSignal
    const suppliedTimeout = options.timeoutMs === undefined ? 10_000 : options.timeoutMs
    if (typeof suppliedTimeout !== 'number') return fallback(request, 'configuration', providerId, model)
    timeoutMs = suppliedTimeout
  } catch { return fallback(request, 'configuration', providerId, model) }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    return fallback(request, 'configuration', providerId, model)
  }
  const controller = new AbortController()
  const startedAt = performance.now()
  let active = true
  let timedOut = false
  let rejectAborted: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = () => reject(new ProviderRequestError(providerId === 'openai' ? 'OpenAI' : 'OpenRouter',
      timedOut ? 'timeout' : 'aborted', 'Decision evaluation cancelled'))
  })
  // A pre-aborted signal can finish before the race is installed.
  void aborted.catch(() => {})
  controller.signal.addEventListener('abort', rejectAborted, { once: true })
  const abort = (): void => controller.abort()
  if (signal) EventTarget.prototype.addEventListener.call(signal, 'abort', abort, { once: true })
  const timer = setTimeout(() => { timedOut = true; abort() }, timeoutMs)
  if (externallyAborted()) abort()
  const check = (): DecisionReasonCode | undefined => {
    if (externallyAborted()) return 'aborted'
    if (timedOut || performance.now() - startedAt >= timeoutMs) { timedOut = true; abort(); return 'timeout' }
    if (!active || controller.signal.aborted) return 'aborted'
    return undefined
  }
  const guardedFallback = (reason: DecisionReasonCode, httpStatus?: number, usage?: DecisionUsage): DecisionResult => {
    const stopped = check()
    return fallback(request, stopped ?? reason, providerId, model, stopped ? undefined : httpStatus, usage)
  }
  try {
    const before = check()
    if (before) return guardedFallback(before)
    const response = await Promise.race([Promise.resolve().then(() => {
      const stopped = check()
      if (stopped) throw new ProviderRequestError(providerId === 'openai' ? 'OpenAI' : 'OpenRouter',
        stopped === 'timeout' ? 'timeout' : 'aborted', 'Decision evaluation cancelled')
      return provider.evaluate(request, controller.signal)
    }), aborted])
    const after = check()
    if (after) return guardedFallback(after)
    // Copy before reading so accessors and external mutation never bypass validation.
    let data: unknown
    try { data = copyJson(response) } catch { return guardedFallback('invalid_response') }
    if (!record(data) || !keys(data, ['model', 'answers', 'usage']) || !supportedModel(providerId, data.model) ||
        provider.id !== providerId || provider.model !== model) return guardedFallback('invalid_response')
    if (providerId === 'openai' && data.model !== model) return guardedFallback('unsupported_model')
    if (!Array.isArray(data.answers) || data.answers.length !== request.policy.checks.length || !validUsage(data.usage)) {
      return guardedFallback('invalid_response')
    }
    const answers = new Map<string, number | 'refusal'>()
    for (const answer of data.answers) {
      if (!record(answer) || typeof answer.name !== 'string' || answers.has(answer.name) ||
          !request.policy.checks.some((item) => item.name === answer.name)) return guardedFallback('invalid_response')
      if (answer.type === 'refusal' && keys(answer, ['name', 'type'])) answers.set(answer.name, 'refusal')
      else if (answer.type === 'predicate' && keys(answer, ['name', 'type', 'probability']) && probability(answer.probability)) {
        answers.set(answer.name, answer.probability)
      } else return guardedFallback('invalid_response')
    }
    if ([...answers.values()].includes('refusal')) return guardedFallback('refusal', undefined, data.usage)
    const checks: DecisionCheckResult[] = request.policy.checks.map((item) => {
      const value = answers.get(item.name) as number
      return Object.freeze({ name: item.name, probability: value,
        reasonCode: item.denyAt !== undefined && value <= item.denyAt ? 'deny_threshold_met' :
          value >= item.allowAt ? 'allow_threshold_met' : 'between_thresholds' })
    })
    const ended = check()
    if (ended) return guardedFallback(ended)
    const deny = checks.some((item) => item.reasonCode === 'deny_threshold_met')
    const uncertain = checks.some((item) => item.reasonCode === 'between_thresholds')
    return finish(request, {
      outcome: deny ? 'deny' : uncertain ? 'ask' : 'allow',
      reasonCode: deny ? 'provider_recommended_reject' : uncertain ? 'uncertain' : 'requirements_met',
      checks: Object.freeze(checks), provider: providerId, model: data.model, usage: Object.freeze({ ...data.usage })
    })
  } catch (error) {
    const stopped = check()
    if (stopped) return guardedFallback(stopped)
    try {
      if (error instanceof ProviderRequestError) {
        const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value
        const status: unknown = Object.getOwnPropertyDescriptor(error, 'status')?.value
        if (typeof code !== 'string' || !['configuration', 'http', 'transport', 'invalid_response', 'timeout', 'aborted'].includes(code)) {
          return guardedFallback('transport')
        }
        const httpStatus = code === 'http' && Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599 ?
          status as number : undefined
        const reason = code === 'http' && httpStatus === 429 ? 'rate_limit' : code as DecisionReasonCode
        return guardedFallback(reason, httpStatus)
      }
    } catch { return guardedFallback('transport') }
    return guardedFallback('transport')
  } finally {
    active = false
    clearTimeout(timer)
    if (signal) EventTarget.prototype.removeEventListener.call(signal, 'abort', abort)
    controller.signal.removeEventListener('abort', rejectAborted)
    controller.abort()
  }
}
