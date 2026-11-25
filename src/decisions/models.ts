// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import { copyJson, invalid } from './validation.js'
import type { DecisionProviderId } from './types.js'

export function supportedModel(provider: DecisionProviderId, model: unknown): model is string {
  return provider === 'openai' ? model === 'gpt-6-luna' : typeof model === 'string' && model.length <= 200 && model === model.trim() &&
    /^[~A-Za-z0-9][A-Za-z0-9._~-]*\/[~A-Za-z0-9][A-Za-z0-9._~:/-]*$/.test(model)
}

/** Exact host-owned identity binding, captured before any asynchronous work. */
export function responseModels(provider: DecisionProviderId, model: string, supplied: unknown): readonly string[] {
  if (!supportedModel(provider, model)) invalid()
  if (provider === 'openai') {
    if (supplied !== undefined) invalid()
    return Object.freeze([model])
  }
  if (supplied === undefined) return Object.freeze(model === 'typesafe/jev-1.13' ?
    [model, 'typesafe/jev-1.13-20260917'] : [model])
  const copied = copyJson(supplied)
  if (!Array.isArray(copied) || copied.length < 1 || copied.length > 16 ||
      !copied.every((item) => supportedModel(provider, item)) || new Set(copied).size !== copied.length) invalid()
  return copied as readonly string[]
}
