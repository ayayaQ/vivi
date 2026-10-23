/- SPDX-License-Identifier: Apache-2.0
   Copyright 2026 ayayaQ -/
namespace PreparedAction

inductive Kind where | read | write | external | unknown deriving BEq, ReflBEq, LawfulBEq, DecidableEq, Repr
inductive Scope where | workspace | outsideWorkspace | external | unknown deriving BEq, ReflBEq, LawfulBEq, DecidableEq, Repr
inductive Review where | ordinaryRead | modelReview | manual | blocked deriving BEq, ReflBEq, LawfulBEq, DecidableEq, Repr
structure Effect where
  kind : Kind
  scope : Scope
  review : Review
  deriving Repr
inductive Reason where
  | missingMetadata | hostBlocked | hostManual | incompleteEffects | unknownEffects
  | invalidClassification | ordinaryWorkspaceRead | modelReviewRequired
  deriving BEq, ReflBEq, LawfulBEq, DecidableEq, Repr

-- The input is the projection AFTER copyJson and validateSnapshot succeed.
-- Resource identity/data do not affect routing after that validation boundary.
def blocked (xs : List Effect) := xs.any (·.review == .blocked)
def manual (xs : List Effect) := xs.any (·.review == .manual)
def unknown (xs : List Effect) := xs.any (fun e => e.kind == .unknown || e.scope == .unknown)
def misclassified (xs : List Effect) := xs.any (fun e =>
  e.review == .ordinaryRead && (e.kind != .read || e.scope != .workspace))
def ordinary (xs : List Effect) := xs.all (·.review == .ordinaryRead)

def route (complete : Bool) (xs : List Effect) : Reason :=
  if blocked xs then .hostBlocked
  else if manual xs then .hostManual
  else if !complete || xs.isEmpty then .incompleteEffects
  else if unknown xs then .unknownEffects
  else if misclassified xs then .invalidClassification
  else if ordinary xs then .ordinaryWorkspaceRead
  else .modelReviewRequired

def routeOptional (action : Option (Bool × List Effect)) : Reason :=
  match action with
  | none => .missingMetadata
  | some (complete, xs) => route complete xs

-- These quantified claims apply to every finite validated effect list, not just fixtures.
theorem blocked_precedence (c : Bool) (xs : List Effect) (h : blocked xs = true) :
    route c xs = .hostBlocked := by simp [route, h]

theorem manual_precedence (c : Bool) (xs : List Effect)
    (hb : blocked xs = false) (hm : manual xs = true) :
    route c xs = .hostManual := by simp [route, hb, hm]

theorem auto_read_guards (c : Bool) (xs : List Effect)
    (h : route c xs = .ordinaryWorkspaceRead) :
    c = true ∧ xs.isEmpty = false ∧ unknown xs = false ∧
      misclassified xs = false ∧ ordinary xs = true := by
  unfold route at h
  split at h <;> simp_all
  split at h <;> simp_all
  split at h <;> simp_all
  split at h <;> simp_all
  split at h <;> simp_all

theorem auto_read_effects (c : Bool) (xs : List Effect)
    (h : route c xs = .ordinaryWorkspaceRead) :
    ∀ e ∈ xs, e.kind = .read ∧ e.scope = .workspace ∧ e.review = .ordinaryRead := by
  have guards := auto_read_guards c xs h
  have hm := guards.2.2.2.1
  have ho := guards.2.2.2.2
  simp only [misclassified, List.any_eq_false] at hm
  simp only [ordinary, List.all_eq_true] at ho
  intro e he
  have a := hm e he
  have b := ho e he
  cases e with
  | mk k s r => cases k <;> cases s <;> cases r <;> simp_all

end PreparedAction
