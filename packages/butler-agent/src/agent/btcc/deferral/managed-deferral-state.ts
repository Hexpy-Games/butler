import { contentRef, type PhaseInvocation } from "../core/index.ts";
import type { TurnRecord } from "../turn/index.ts";
import { requireManagedPlanningAuthority, requireManagedState } from "../turn/index.ts";
import type { ManagedDeferralContext, ManagedDeferralSource } from "./contracts.ts";

export function withManagedDeferralState(
  phase: PhaseInvocation,
  turn: TurnRecord,
  stateInput: Record<string, unknown>,
): PhaseInvocation {
  return {
    ...phase,
    context: {
      ...phase.context,
      stateInput: {
        ...stateInput,
        deferralContext: deferralContextFor(turn),
      },
    },
  };
}

function deferralContextFor(turn: TurnRecord): ManagedDeferralContext {
  const managed = requireManagedState(turn);
  const authority = requireManagedPlanningAuthority(turn);
  const accepted = managed.goalAcceptance;
  if (!accepted) throw new Error("Managed deferral requires accepted Goal authority");
  const sourceState = requireDeferralSource(turn.semanticState);
  const phaseRef = contentRef("phase-envelope", {
    turnId: turn.turnId,
    turnRevision: turn.revision,
    semanticState: sourceState,
    checkpointId: turn.checkpoint?.checkpointId,
  });
  if (authority.planningState === "unplanned") {
    return {
      programId: authority.programId,
      goalContractRef: authority.goalContractRef,
      authorityRef: authority.authorityRef,
      planAuthority: { kind: "pre_plan", sourcePhaseEnvelopeRef: phaseRef },
      openWorkRefs: [],
      openTaskRefs: [],
      workspaceRefs: [],
      workspaceRevisionRefs: [],
      promotionContext: { kind: "not_promotion" },
      sourceTurnId: turn.turnId,
      sourceTurnRevision: turn.revision,
      sourceState,
      requiredOutcomeId: authority.requiredOutcomeId,
    };
  }
  const currentAttempt = authority.currentTask.attempts.at(-1);
  const workspaceRefs = authority.tasks.flatMap((task) => task.attempts.flatMap((attempt) =>
    attempt.executionTarget.target.kind === "provisioned_workspace"
      ? [attempt.executionTarget.target.workspaceRef]
      : []));
  const workspaceRevisionRefs = authority.tasks.flatMap((task) =>
    task.currentResult?.result.kind === "workspace_artifact"
      ? [task.currentResult.result.workspaceRevisionRef]
      : []);
  return {
    programId: authority.programId,
    goalContractRef: authority.goalContractRef,
    authorityRef: authority.authorityRef,
    planAuthority: {
      kind: "accepted_plan",
      acceptedPlanRef: authority.plan.ref,
      planningReviewRef: authority.planningReviewRef,
      sourcePhaseEnvelopeRef: phaseRef,
    },
    currentWorkRef: authority.currentWork.work.ref,
    currentTaskRef: authority.currentTask.task.ref,
    ...(currentAttempt ? { currentAttemptRef: currentAttempt.ref } : {}),
    openWorkRefs: authority.works
      .filter((work) => work.status !== "closed")
      .map((work) => work.work.ref),
    openTaskRefs: authority.tasks
      .filter((task) => task.status !== "accepted")
      .map((task) => task.task.ref),
    workspaceRefs: uniqueRefs(workspaceRefs),
    workspaceRevisionRefs: uniqueRefs(workspaceRevisionRefs),
    promotionContext: authority.frontier === "promotion_open" && authority.promotionAuthorization
      ? {
          kind: "pre_commit_before_transaction",
          authorizationRef: authority.promotionAuthorization.ref,
          promotionTaskRef: authority.currentTask.task.ref,
        }
      : { kind: "not_promotion" },
    sourceTurnId: turn.turnId,
    sourceTurnRevision: turn.revision,
    sourceState,
    requiredOutcomeId: authority.requiredOutcomeId,
  };
}

function requireDeferralSource(state: TurnRecord["semanticState"]): ManagedDeferralSource {
  const allowed: ManagedDeferralSource[] = [
    "planning", "planning_review", "task_execution", "task_review",
    "feedback_conception", "feedback_planning", "feedback_planning_review",
  ];
  if (!allowed.includes(state as ManagedDeferralSource)) {
    throw new Error(`BTCC state cannot submit managed deferral: ${state}`);
  }
  return state as ManagedDeferralSource;
}

function uniqueRefs<T extends { id: string; sha256: string }>(refs: T[]): T[] {
  return [...new Map(refs.map((ref) => [ref.id, ref])).values()];
}
