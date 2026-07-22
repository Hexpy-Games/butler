import type { PhaseInvocation } from "../core/index.ts";
import { withPhaseState } from "../core/index.ts";
import type { GoalContractAcceptedProduct } from "../conception/index.ts";
import type { ManagedDeferralProduct } from "../deferral/index.ts";
import {
  requireManagedPlanningAuthority,
  requireManagedProgram,
  requireManagedState,
  type TurnEvent,
  type TurnRecord,
} from "../turn/index.ts";
import { assureOriginalGoal } from "./assure-original-goal.ts";

export async function consolidation(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<Extract<TurnEvent, {
  kind: "ConsolidationRepairRequired" | "FinalDossierAccepted" | "PromotionAuthorized";
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
  return consolidateCompletedWork(command, accepted);
}

async function consolidateDeferredTurn(
  command: { turn: TurnRecord; phase: PhaseInvocation },
  accepted: GoalContractAcceptedProduct,
  sourceDeferral: ManagedDeferralProduct,
): Promise<Extract<TurnEvent, { kind: "FinalDossierAccepted" }>> {
  const authority = requireManagedPlanningAuthority(command.turn);
  const reviewed = authority.planningState === "reviewed" ? authority : undefined;
  const product = await assureOriginalGoal(withPhaseState(command.phase, {
    frontier: "deferred",
    taskStatuses: [],
    programId: authority.programId,
    acceptedGoalContract: accepted.goalContract,
    acceptedAuthority: accepted.authority,
    goalContractRef: authority.goalContractRef,
    authorityRef: authority.authorityRef,
    goalFields: accepted.goalContract.fields,
    taskReviewRefs: reviewed?.tasks.flatMap((task) =>
      task.currentReview?.review.verdict === "passed" ? [task.currentReview.review.ref] : []) ?? [],
    candidateRefs: reviewed?.promotionAssemblies.map((assembly) => assembly.candidate.ref) ?? [],
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
  kind: "ConsolidationRepairRequired" | "FinalDossierAccepted" | "PromotionAuthorized";
}>> {
  const program = requireManagedProgram(command.turn);
  const implementationTasks = program.tasks.filter(
    (task) => task.task.artifactPolicy.kind !== "repository_promotion",
  );
  const reviews = implementationTasks.map((task) => task.currentReview);
  if (reviews.some((review) => !review || review.review.verdict !== "passed")) {
    throw new Error("Consolidation requires every passed Task Review");
  }
  const product = await assureOriginalGoal(withPhaseState(command.phase, {
    acceptedGoalContract: accepted.goalContract,
    acceptedAuthority: accepted.authority,
    acceptedPlan: program.plan,
    managedWorks: program.works,
    managedTasks: program.tasks,
    criteria: program.criteria,
    integrationCriteria: program.plan.integrationCriterionRefs,
    artifactLifecycle: program.artifactLifecycle,
    frontier: program.frontier,
    taskStatuses: implementationTasks.map((task) => task.status),
    taskRefs: implementationTasks.map((task) => task.task.ref),
    goalFields: accepted.goalContract.fields,
    programId: program.programId,
    goalContractRef: program.goalContractRef,
    authorityRef: program.authorityRef,
    planRef: program.plan.ref,
    planningReviewRef: program.planningReviewRef,
    taskReviewRefs: reviews.map((review) => review!.review.ref),
    promotionAssemblies: program.promotionAssemblies,
    candidateRefs: program.promotionAssemblies.map((assembly) => assembly.candidate.ref),
  }));
  return product.kind === "consolidation_repair"
    ? { kind: "ConsolidationRepairRequired", product }
    : product.kind === "promotion_authorization"
    ? { kind: "PromotionAuthorized", product }
    : { kind: "FinalDossierAccepted", product };
}
