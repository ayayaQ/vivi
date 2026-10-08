// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import { copyJson, validateSnapshot } from './validation.js'
import type { DecisionRequest, DecisionSnapshot, PreparedActionRoute } from './types.js'

/** Pure routing over trusted host metadata. It never infers effects or checks actual access/state. */
export function routePreparedAction(snapshot: DecisionSnapshot | DecisionRequest['snapshot']): PreparedActionRoute {
  const result = (route: PreparedActionRoute['route'], reasonCode: PreparedActionRoute['reasonCode']): PreparedActionRoute =>
    Object.freeze({ route, reasonCode })
  let state: DecisionRequest['snapshot']
  try {
    const copied = copyJson(snapshot)
    validateSnapshot(copied)
    state = copied as unknown as DecisionRequest['snapshot']
  } catch { return result('manual', 'invalid_snapshot') }
  const action = state.preparedAction
  if (!action) return result('manual', 'missing_metadata')
  const effects = action.effects
  if (effects.some((effect) => effect.review === 'blocked')) return result('blocked', 'host_blocked')
  if (effects.some((effect) => effect.review === 'manual')) return result('manual', 'host_manual')
  if (!action.complete || effects.length === 0) return result('manual', 'incomplete_effects')
  if (effects.some((effect) => effect.kind === 'unknown' || effect.scope === 'unknown')) return result('manual', 'unknown_effects')
  if (effects.some((effect) => effect.review === 'ordinary-read' &&
      (effect.kind !== 'read' || effect.scope !== 'workspace'))) return result('manual', 'invalid_classification')
  if (effects.every((effect) => effect.review === 'ordinary-read')) return result('auto-read', 'ordinary_workspace_read')
  return result('model-review', 'model_review_required')
}
