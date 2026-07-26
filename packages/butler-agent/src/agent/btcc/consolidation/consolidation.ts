import type { PhaseInvocation } from "../core/index.ts";
import { withPhaseState } from "../core/index.ts";
import type { GoalContractAcceptedProduct } from "../conception/index.ts";
import type { ManagedDeferralProduct } from "../deferral/index.ts";
import type { ReviewedManagedProgramState } from "../work-ledger/index.ts";
import {
  requireManagedPlanningAuthority,
  requireManagedProgram,
  requireManagedState,
  type TurnEvent,
  type TurnRecord,
} from "../turn/index.ts";
import { assureOriginalGoal } from "./assure-original-goal.ts";
import { projectTaskOutcomes } from "./project-task-outcomes.ts";

export async function consolidation(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<Extract<TurnEvent, {
  kind: "ConsolidationRepairRequired" | "FinalDossierAccepted";
}>> {
  if (command.turn.semanticState !== "consolidation") {
    throw new Error(`Consolidation cannot advance ${command.turn.semanticState}`);
  }
  const managed = requireManagedState(command.turn);
  const accepted = managed.goalAcceptance;
  if (!accepted) throw new Error("Consolidation is missing the accepted GoalContract");
  if (managed.deferral) {
    return consolidateDeferredTurn(command, accepted, managed.deferral);
  }
  const program = requireManagedProgram(command.turn);
  if (program.frontier === "closed" && program.promotionDeferral) {
    if (!program.activeDeferral) {
      throw new Error("Deferred promotion has no active deferral context");
    }
    return consolidateDeferredTurn(command, accepted, program.activeDeferral, program);
  }
  return consolidateCompletedWork(command, accepted);
}

async function consolidateDeferredTurn(
  command: { turn: TurnRecord; phase: PhaseInvocation },
  accepted: GoalContractAcceptedProduct,
  sourceDeferral: ManagedDeferralProduct,
  sourceProgram?: ReviewedManagedProgramState,
): Promise<Extract<TurnEvent, { kind: "FinalDossierAccepted" }>> {
  const authority = requireManagedPlanningAuthority(command.turn);
  const reviewed = sourceProgram ?? (authority.planningState === "reviewed" ? authority : undefined);
  const passedReviews = reviewed?.tasks.flatMap((task) =>
    task.currentReview?.review.verdict === "passed" ? [task.currentReview.review.ref] : []) ?? [];
  const product = await assureOriginalGoal(withPhaseState(command.phase, {
    frontier: "deferred",
    taskStatuses: [],
    programId: authority.programId,
    acceptedGoalContract: accepted.goalContract,
    acceptedAuthority: accepted.authority,
    goalContractRef: authority.goalContractRef,
    authorityRef: authority.authorityRef,
    goalFields: accepted.goalContract.fields,
    taskReviewRefs: passedReviews,
    candidateRefs: reviewed?.promotionAssemblies.map((assembly) => assembly.candidate.ref) ?? [],
    promotionClosure: sourceProgram ? "deferred" : "not_required",
    ...(reviewed
      ? { planRef: reviewed.plan.ref, planningReviewRef: reviewed.planningReviewRef }
      : {}),
    sourceDeferral,
  }));
  if (product.kind !== "final_dossier") {
    throw new Error("Deferred Consolidation cannot authorize promotion");
  }
  return { kind: "FinalDossierAccepted", product };
}

async function consolidateCompletedWork(
  command: { turn: TurnRecord; phase: PhaseInvocation },
  accepted: GoalContractAcceptedProduct,
): Promise<Extract<TurnEvent, {
  kind: "ConsolidationRepairRequired" | "FinalDossierAccepted";
}>> {
  const program = requireManagedProgram(command.turn);
  const taskOutcomes = projectTaskOutcomes(program.tasks);
  const product = await assureOriginalGoal(withPhaseState(command.phase, {
    acceptedGoalContract: accepted.goalContract,
    acceptedAuthority: accepted.authority,
    acceptedPlan: program.plan,
    managedWorks: program.works,
    taskOutcomes,
    criteria: program.criteria,
    integrationCriteria: program.plan.integrationCriterionRefs,
    artifactLifecycle: program.artifactLifecycle,
    frontier: program.frontier,
    taskStatuses: program.tasks.map((task) => task.status),
    taskRefs: program.tasks.map((task) => task.task.ref),
    goalFields: accepted.goalContract.fields,
    programId: program.programId,
    goalContractRef: program.goalContractRef,
    authorityRef: program.authorityRef,
    planRef: program.plan.ref,
    planningReviewRef: program.planningReviewRef,
    taskReviewRefs: taskOutcomes.map((outcome) => outcome.review.ref),
    promotionClosure: program.tasks.some(
      (task) => task.task.artifactPolicy.kind === "repository_promotion",
    ) ? "promoted" : "not_required",
    candidateRefs: program.promotionAssemblies.map((assembly) => assembly.candidate.ref),
  }));
  return product.kind === "consolidation_repair"
    ? { kind: "ConsolidationRepairRequired", product }
    : { kind: "FinalDossierAccepted", product };
}
