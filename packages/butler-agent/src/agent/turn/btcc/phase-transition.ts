import type {
  BtccDependencyAuthority,
  BtccPhase,
  BtccPhaseLifecycleStatus,
  BtccPhaseReceiptNextState,
  BtccPhaseStateV1,
  PhaseReceiptV1,
} from "./phase-types.ts";

const PHASE_TRANSITIONS: Record<BtccPhase, ReadonlySet<BtccPhaseReceiptNextState>> = {
  conception: new Set([
    "planning",
    "waiting_user",
    "waiting_external",
    "waiting_runtime",
    "scheduled_continuation",
  ]),
  planning: new Set([
    "conception",
    "execution",
    "waiting_user",
    "waiting_external",
    "waiting_runtime",
    "scheduled_continuation",
  ]),
  execution: new Set([
    "review",
    "waiting_user",
    "waiting_external",
    "waiting_runtime",
    "scheduled_continuation",
  ]),
  review: new Set([
    "planning",
    "execution",
    "consolidation",
    "waiting_user",
    "waiting_external",
    "waiting_runtime",
    "scheduled_continuation",
  ]),
  consolidation: new Set([
    "planning",
    "execution",
    "review",
    "reporting",
    "waiting_user",
    "waiting_external",
    "waiting_runtime",
    "scheduled_continuation",
  ]),
  reporting: new Set([
    "conception",
    "planning",
    "execution",
    "review",
    "reporting",
    "waiting_user",
    "waiting_external",
    "waiting_runtime",
    "scheduled_continuation",
    "kernel_delivery",
  ]),
};

export function assertBtccPhaseReceiptTransition(
  state: BtccPhaseStateV1,
  receipt: PhaseReceiptV1,
): void {
  if (state.lifecycleStatus !== "active") {
    throw new Error(`btcc_phase_transition_requires_active:${state.lifecycleStatus}`);
  }
  if (
    receipt.turnId !== state.turnId ||
    receipt.attemptId !== state.attemptId ||
    receipt.phase !== state.currentPhase ||
    receipt.phaseGeneration !== state.phaseGeneration
  ) {
    throw new Error("btcc_phase_receipt_target_mismatch");
  }
  if (receipt.status !== "passed") {
    throw new Error("btcc_phase_receipt_status_invalid");
  }
  if (!PHASE_TRANSITIONS[state.currentPhase].has(receipt.nextState)) {
    throw new Error(
      `btcc_phase_transition_invalid:${state.currentPhase}:${receipt.nextState}`,
    );
  }
  if (!receipt.inputFingerprint.trim() || !receipt.phasePromptHash.trim()) {
    throw new Error("btcc_phase_receipt_integrity_missing");
  }
}

export function phaseAndLifecycleForReceipt(
  currentPhase: BtccPhase,
  nextState: BtccPhaseReceiptNextState,
): { phase: BtccPhase; lifecycle: BtccPhaseLifecycleStatus; phaseChanged: boolean } {
  if (nextState === "kernel_delivery") {
    return { phase: "reporting", lifecycle: "active", phaseChanged: false };
  }
  if (
    nextState === "waiting_user" ||
    nextState === "waiting_external" ||
    nextState === "waiting_runtime" ||
    nextState === "scheduled_continuation"
  ) {
    return { phase: currentPhase, lifecycle: nextState, phaseChanged: false };
  }
  return {
    phase: nextState,
    lifecycle: "active",
    phaseChanged: nextState !== currentPhase,
  };
}

export function invalidatedPhasesForAuthority(
  authority: BtccDependencyAuthority,
): ReadonlySet<BtccPhase> {
  switch (authority) {
    case "goal_contract":
      return new Set(["planning", "execution", "review", "consolidation", "reporting"]);
    case "governing_contract":
      return new Set(["planning", "execution", "review", "consolidation", "reporting"]);
    case "plan_or_task_graph":
      return new Set(["execution", "review", "consolidation", "reporting"]);
    case "task_artifact_or_evidence":
      return new Set(["execution", "review", "consolidation", "reporting"]);
    case "task_review":
      return new Set(["review", "consolidation", "reporting"]);
    case "final_dossier":
      return new Set(["reporting"]);
  }
}
