// SPDX-License-Identifier: Apache-2.0
// Bounded descriptor-only JSON capture shared with the audited Event contract.
import { types } from 'node:util'

const controls = /[\u0000-\u001f\u007f-\u009f]/

export function eventText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !controls.test(value)
}

/** No property reads, getters, non-enumerable fields, symbols or custom prototypes. */
export function eventObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false
  return Reflect.ownKeys(value).every(key => {
    if (typeof key !== 'string') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && descriptor.enumerable === true && 'value' in descriptor
  })
}

/** Bound structure and encoded UTF-8 size before JSON.stringify, cloning or compilation. */
export function assertEventJson(value: unknown, maxBytes: number,
  limits: { readonly nodes?: number; readonly depth?: number } = {}): void {
  const maxNodes = limits.nodes ?? 4096, maxDepth = limits.depth ?? 32
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxNodes) || maxNodes < 1 ||
    !Number.isSafeInteger(maxDepth) || maxDepth < 0) throw new Error('Invalid Event JSON limits')
  const active = new WeakSet<object>()
  let nodes = 0, bytes = 0
  const add = (size: number): void => {
    bytes += size
    if (bytes > maxBytes) throw new Error('Event JSON exceeds its byte limit')
  }
  // JSON.stringify escapes lone surrogates. Count them without first allocating an encoded string.
  const string = (text: string): void => {
    add(2)
    for (let index = 0; index < text.length; index++) {
      const unit = text.charCodeAt(index)
      if (unit === 34 || unit === 92 || [8, 9, 10, 12, 13].includes(unit)) add(2)
      else if (unit < 32) add(6)
      else if (unit < 128) add(1)
      else if (unit < 2048) add(2)
      else if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(index + 1)
        if (next >= 0xdc00 && next <= 0xdfff) { add(4); index++ } else add(6)
      } else if (unit >= 0xdc00 && unit <= 0xdfff) add(6)
      else add(3)
    }
  }
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > maxNodes || depth > maxDepth) throw new Error('Event JSON complexity limit exceeded')
    if (item === null) { add(4); return }
    if (typeof item === 'boolean') { add(item ? 4 : 5); return }
    if (typeof item === 'number' && Number.isFinite(item)) { add(String(item).length); return }
    if (typeof item === 'string') { string(item); return }
    if (item === null || typeof item !== 'object' || types.isProxy(item) || active.has(item)) throw new Error('Event data must be acyclic plain JSON')
    active.add(item)
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > maxNodes - nodes) throw new Error('Event array must be bounded plain JSON')
      const keys = Reflect.ownKeys(item)
      if (keys.length !== item.length + 1 || keys.some(key => typeof key !== 'string')) throw new Error('Event arrays cannot have extra properties')
      add(2 + Math.max(0, item.length - 1))
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Event arrays cannot have holes or accessors')
        visit(descriptor.value, depth + 1)
      }
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype) throw new Error('Event data must be plain JSON')
      const keys = Reflect.ownKeys(item)
      if (keys.length > maxNodes - nodes) throw new Error('Event JSON complexity limit exceeded')
      add(2 + Math.max(0, keys.length - 1))
      for (const key of keys) {
        if (typeof key !== 'string') throw new Error('Event JSON cannot have symbol properties')
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Event JSON cannot have hidden fields or accessors')
        string(key); add(1); visit(descriptor.value, depth + 1)
      }
    }
    active.delete(item)
  }
  visit(value, 0)
}


/** Capture only bounded, ordinary arrays without invoking a caller iterator/getter. */
export function captureEventArray(input: unknown, limit: number): unknown[] {
  if (input === null || typeof input !== 'object' || types.isProxy(input) || !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype || input.length > limit) throw new Error('Record chain must be a bounded plain array')
  const keys = Reflect.ownKeys(input)
  if (keys.length !== input.length + 1 || keys.some(key => typeof key !== 'string')) throw new Error('Record chain cannot have extra properties')
  const captured: unknown[] = []
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Record chain cannot contain holes or accessors')
    captured.push(descriptor.value)
  }
  return captured
}
