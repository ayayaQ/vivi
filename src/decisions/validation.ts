// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import type { ReadonlyJson } from './types.js'

export const MAX_DECISION_BYTES = 65_536
export const MAX_DECISION_CHECKS = 16

/** Sanitized programming/configuration errors do not retain the rejected input. */
export class DecisionConfigurationError extends Error {
  constructor() {
    super('Invalid decision request or policy configuration')
    this.name = 'DecisionConfigurationError'
  }
}

export function invalid(): never { throw new DecisionConfigurationError() }

export function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
}

export function text(value: unknown, limit = 8_192): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit
}

export function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/** Call only on copied plain JSON. Resource identities are opaque literal keys, never resolved here. */
export function validateSnapshot(state: unknown): void {
  if (!record(state) ||
      !keys(state, ['sessionId', 'runId', 'toolCall', 'userRequest', 'policyRevision', 'resourceRevisions', 'inputData'], ['preparedAction']) ||
      !text(state.sessionId, 256) || !text(state.runId, 256) || !text(state.policyRevision, 256) ||
      !record(state.resourceRevisions) || !record(state.toolCall) || !record(state.userRequest)) invalid()
  if (!keys(state.toolCall, ['id', 'name', 'arguments']) || !text(state.toolCall.id, 256) ||
      !text(state.toolCall.name, 256) || !record(state.toolCall.arguments)) invalid()
  if (!keys(state.userRequest, ['id', 'text', 'approvedScope']) || !text(state.userRequest.id, 256) ||
      !text(state.userRequest.text)) invalid()
  if (!Object.hasOwn(state, 'preparedAction')) return
  const action = state.preparedAction
  if (!record(action) || !keys(action, ['complete', 'effects']) || typeof action.complete !== 'boolean' ||
      !Array.isArray(action.effects) || action.effects.length > 256) invalid()
  for (const effect of action.effects) {
    if (!record(effect) || !keys(effect, ['kind', 'resourceId', 'scope', 'affectedData', 'review']) ||
        !['read', 'write', 'external', 'unknown'].includes(effect.kind as string) ||
        !text(effect.resourceId, 1_024) || !Object.hasOwn(state.resourceRevisions, effect.resourceId) ||
        !['workspace', 'outside-workspace', 'external', 'unknown'].includes(effect.scope as string) ||
        !['ordinary-read', 'model-review', 'manual', 'blocked'].includes(effect.review as string)) invalid()
  }
}

/** Plain JSON only: reject accessors, cycles, custom prototypes, sparse arrays, and excess depth/size. */
export function copyJson(value: unknown): ReadonlyJson {
  const ancestors = new Set<object>()
  let budget = MAX_DECISION_BYTES
  const visit = (input: unknown, depth: number): ReadonlyJson => {
    if (depth > 32 || --budget < 0) invalid()
    if (input === null || typeof input === 'boolean') return input
    if (typeof input === 'number') { if (!Number.isFinite(input) || Object.is(input, -0)) invalid(); return input }
    if (typeof input === 'string') { budget -= input.length; if (budget < 0) invalid(); return input }
    if (typeof input !== 'object' || !input || ancestors.has(input)) invalid()
    ancestors.add(input)
    try {
      if (Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype || Reflect.ownKeys(input).length !== input.length + 1) invalid()
        const output: ReadonlyJson[] = []
        for (let index = 0; index < input.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
          if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid()
          output.push(visit(descriptor.value, depth + 1))
        }
        return Object.freeze(output)
      }
      if (!record(input)) invalid()
      const output: Record<string, ReadonlyJson> = Object.create(null) as Record<string, ReadonlyJson>
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== 'string') invalid()
        budget -= key.length
        const descriptor = Object.getOwnPropertyDescriptor(input, key)
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid()
        output[key] = visit(descriptor.value, depth + 1)
      }
      return Object.freeze(output)
    } finally { ancestors.delete(input) }
  }
  try {
    const output = visit(value, 0)
    if (new TextEncoder().encode(JSON.stringify(output)).byteLength > MAX_DECISION_BYTES) invalid()
    return output
  } catch { return invalid() }
}

/** JSON.parse alone silently overwrites duplicate named answers, including escaped duplicate keys. */
export function parseUnambiguousJson(source: string): unknown {
  let index = 0
  const whitespace = (): void => { while (/[\t\n\r ]/.test(source[index] ?? '\0')) index++ }
  const string = (): string => {
    const start = index++
    while (index < source.length) {
      const char = source[index++]
      if (char === '\\') index++
      else if (char === '"') return JSON.parse(source.slice(start, index)) as string
    }
    return invalid()
  }
  const value = (depth: number): void => {
    if (depth > 32) invalid()
    whitespace()
    const char = source[index]
    if (char === '"') { string(); return }
    if (char === '{') {
      index++; whitespace()
      if (source[index] === '}') { index++; return }
      const seen = new Set<string>()
      while (true) {
        if (source[index] !== '"') invalid()
        const key = string()
        if (seen.has(key)) invalid()
        seen.add(key); whitespace()
        if (source[index++] !== ':') invalid()
        value(depth + 1); whitespace()
        const next = source[index++]
        if (next === '}') return
        if (next !== ',') invalid()
        whitespace()
      }
    }
    if (char === '[') {
      index++; whitespace()
      if (source[index] === ']') { index++; return }
      while (true) {
        value(depth + 1); whitespace()
        const next = source[index++]
        if (next === ']') return
        if (next !== ',') invalid()
      }
    }
    const start = index
    while (index < source.length && !/[\t\n\r ,}\]]/.test(source[index]!)) index++
    if (start === index) invalid()
    JSON.parse(source.slice(start, index))
  }
  value(0); whitespace()
  if (index !== source.length) invalid()
  return JSON.parse(source) as unknown
}

/** Stable object-key order; array order, values, identities, and all revisions are bound exactly. */
export function canonical(value: ReadonlyJson): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as { readonly [key: string]: ReadonlyJson }
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key]!)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
