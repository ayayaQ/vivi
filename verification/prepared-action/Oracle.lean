/- SPDX-License-Identifier: Apache-2.0
   Copyright 2026 ayayaQ -/
import Model
open PreparedAction

def effects : Array Effect := Id.run do
  let mut result := #[]
  for k in [Kind.read, .write, .external, .unknown] do
    for s in [Scope.workspace, .outsideWorkspace, .external, .unknown] do
      for r in [Review.ordinaryRead, .modelReview, .manual, .blocked] do
        result := result.push ⟨k, s, r⟩
  return result

def output (reason : Reason) : String := match reason with
  | .missingMetadata => "manual\tmissing_metadata"
  | .hostBlocked => "blocked\thost_blocked"
  | .hostManual => "manual\thost_manual"
  | .incompleteEffects => "manual\tincomplete_effects"
  | .unknownEffects => "manual\tunknown_effects"
  | .invalidClassification => "manual\tinvalid_classification"
  | .ordinaryWorkspaceRead => "auto-read\tordinary_workspace_read"
  | .modelReviewRequired => "model-review\tmodel_review_required"

def emit (complete : Bool) (ids : List Nat) : IO Unit := do
  let xs := ids.map (fun i => (effects[i]?.getD ⟨.read, .workspace, .ordinaryRead⟩))
  IO.println s!"{if complete then 1 else 0}\t{String.intercalate "," (ids.map toString)}\t{output (routeOptional (some (complete, xs)))}"

def main : IO Unit := do
  IO.println s!"missing\t\t{output (routeOptional none)}"
  for c in [false, true] do
    emit c []
    for i in [:64] do
      emit c [i]
      for j in [:64] do emit c [i,j]
      emit c (List.replicate 256 i)
    -- Deterministic longer lists exercise order and repetitions; not exhaustive.
    for seed in [:1024] do
      let ids := (List.range (3 + seed % 14)).map (fun j => (seed * 17 + j * 29 + j*j) % 64)
      emit c ids
