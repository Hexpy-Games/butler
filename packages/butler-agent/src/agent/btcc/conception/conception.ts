import type { GoverningSpecAuthority } from "../contracts.ts";
import type { PhaseInvocation } from "../core/index.ts";
import { withPhaseState } from "../core/index.ts";
import { isManagedDeferral, withManagedDeferralState } from "../deferral/index.ts";
import {
  requireManagedProgram,
  requireManagedState,
  type TurnEvent,
  type TurnRecord,
} from "../turn/index.ts";
import { answerWithAssistance } from "./assistance/answer-with-assistance.ts";
import { conceiveCorrection } from "./conceive-correction.ts";
import { deliberateGoal } from "./deliberate-goal.ts";
import { openConception } from "./opening/open-conception.ts";
import { projectPriorTaskReviewFindings } from "./prior-task-review-findings.ts";
import { reviewGoalContract } from "./review-goal-contract.ts";

type InitialConceptionEvent = Extract<TurnEvent, {
  kind:
    | "OpeningAnswerAccepted"
    | "OpeningContinuationAccepted"
    | "GoalContractCandidateSubmitted"
    | "GoalContractReviewAccepted"
    | "GoalContractRevisionRequested";
}>;
type FeedbackConceptionEvent = Extract<TurnEvent, {
  kind: "FeedbackIntentAccepted" | "ManagedDeferralAccepted";
}>;
type ConceptionCommand = {
  cycle: "initial" | "review_feedback";
  turn: TurnRecord;
  phase: PhaseInvocation;
  governingSpecs?: GoverningSpecAuthority;
};

export function conception(command: {
  cycle: "initial";
  turn: TurnRecord;
  phase: PhaseInvocation;
  governingSpecs?: GoverningSpecAuthority;
}): Promise<InitialConceptionEvent>;
export function conception(command: {
  cycle: "review_feedback";
  turn: TurnRecord;
  phase: PhaseInvocation;
  governingSpecs?: GoverningSpecAuthority;
}): Promise<FeedbackConceptionEvent>;
export function conception(
  command: ConceptionCommand,
): Promise<InitialConceptionEvent | FeedbackConceptionEvent> {
  return command.cycle === "review_feedback"
    ? conceiveReviewFeedback(command)
    : conceiveInitialGoal(command);
}

async function conceiveInitialGoal(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
  governingSpecs?: GoverningSpecAuthority;
}): Promise<InitialConceptionEvent> {
  switch (command.turn.semanticState) {
    case "conception_opening": {
      const product = await openConception(command.phase);
      return product.kind === "opening_answer"
        ? { kind: "OpeningAnswerAccepted", product }
        : { kind: "OpeningContinuationAccepted", product };
    }
    case "assisted_answer": {
      const product = await answerWithAssistance(command.phase);
      return { kind: "OpeningAnswerAccepted", product };
    }
    case "conception_deliberation": {
      const managed = requireManagedState(command.turn);
      const availableGoverningSpecs = managed.goalRevision
        ?.candidate.availableGoverningSpecs ?? await listGoverningSpecs(command);
      const product = await deliberateGoal(withPhaseState(command.phase, {
        availableGoverningSpecs,
        ...(managed.goalRevision ? { goalRevision: managed.goalRevision } : {}),
      }));
      return { kind: "GoalContractCandidateSubmitted", product };
    }
    case "contract_review": {
      const managed = requireManagedState(command.turn);
      const availableGoverningSpecs =
        managed.goalCandidate?.candidate.availableGoverningSpecs ?? [];
      const selectedGoverningSpecs = await resolveSelectedGoverningSpecs(
        command,
        managed.goalCandidate?.candidate.proposedContract.governingSpecApplications
          .map((application) => application.logicalId) ?? [],
      );
      assertSelectedSpecRevisions(availableGoverningSpecs, selectedGoverningSpecs);
      const product = await reviewGoalContract(withPhaseState(command.phase, {
        inboxId: command.turn.inboxId,
        sessionId: command.turn.sessionId,
        ...(command.turn.context.projectRef
          ? { projectRef: command.turn.context.projectRef }
          : {}),
        continuationCandidates: command.turn.continuationCandidates,
        availableGoverningSpecs,
        selectedGoverningSpecs,
        goalCandidate: managed.goalCandidate,
        ...(managed.goalRevision ? { goalRevision: managed.goalRevision } : {}),
      }));
      return product.kind === "goal_contract_accepted"
        ? { kind: "GoalContractReviewAccepted", product }
        : { kind: "GoalContractRevisionRequested", product };
    }
    default:
      throw new Error(`Conception cannot advance ${command.turn.semanticState}`);
  }
}

function assertSelectedSpecRevisions(
  available: Awaited<ReturnType<typeof listGoverningSpecs>>,
  selected: Awaited<ReturnType<typeof resolveSelectedGoverningSpecs>>,
) {
  const admitted = new Map(
    available.map((spec) => [spec.logicalId, spec.revisionRef]),
  );
  for (const spec of selected) {
    const expected = admitted.get(spec.logicalId);
    if (
      !expected ||
      expected.id !== spec.revisionRef.id ||
      expected.sha256 !== spec.revisionRef.sha256
    ) {
      throw new Error(`Governing Spec authority changed: ${spec.logicalId}`);
    }
  }
}

function listGoverningSpecs(command: {
  turn: TurnRecord;
  governingSpecs?: GoverningSpecAuthority;
}) {
  const projectRef = command.turn.context.projectRef;
  if (!projectRef || !command.governingSpecs) return Promise.resolve([]);
  return command.governingSpecs.listCatalog(projectRef);
}

function resolveSelectedGoverningSpecs(
  command: {
    turn: TurnRecord;
    governingSpecs?: GoverningSpecAuthority;
  },
  logicalIds: readonly string[],
) {
  if (logicalIds.length === 0) return Promise.resolve([]);
  const projectRef = command.turn.context.projectRef;
  if (!projectRef || !command.governingSpecs) {
    throw new Error("Selected governing Specs have no admitted project authority");
  }
  return command.governingSpecs.resolveSelected(projectRef, logicalIds);
}

async function conceiveReviewFeedback(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<FeedbackConceptionEvent> {
  const program = requireManagedProgram(command.turn);
  const accepted = requireManagedState(command.turn).goalAcceptance;
  if (!accepted) throw new Error("Feedback Conception is missing accepted Goal authority");
  const source = feedbackSource(command.turn, program);
  const product = await conceiveCorrection(withManagedDeferralState(command.phase, command.turn, {
    acceptedGoalContract: accepted.goalContract,
    acceptedAuthority: accepted.authority,
    acceptedPlan: program.plan,
    currentWork: program.currentWork.work,
    currentTask: program.currentTask.task,
    correctionSource: source.record,
    correctionScopeRef: source.correctionScopeRef,
    correctionOrigin: source.origin,
    affectedTaskRefs: source.affectedTaskRefs,
    priorTaskReviewFindings: projectPriorTaskReviewFindings(
      program.currentTask,
      source.origin === "task_review" ? source.record.review.ref : undefined,
    ),
    goalContractRef: program.goalContractRef,
    authorityRef: program.authorityRef,
  }));
  return isManagedDeferral(product)
    ? { kind: "ManagedDeferralAccepted", product }
    : { kind: "FeedbackIntentAccepted", product };
}

function feedbackSource(
  turn: TurnRecord,
  program: ReturnType<typeof requireManagedProgram>,
) {
  const repair = requireManagedState(turn).consolidationRepair?.repair;
  if (repair) {
    return {
      origin: "consolidation" as const,
      record: repair,
      correctionScopeRef: repair.correctionScope.ref,
      affectedTaskRefs: repair.correctionScope.affectedTaskRefs,
    };
  }
  const review = program.currentTask.currentReview;
  if (!review || review.review.verdict !== "not_passed") {
    throw new Error("Feedback Conception requires a failed Task Review or Consolidation repair");
  }
  return {
    origin: "task_review" as const,
    record: review,
    correctionScopeRef: review.review.correctionScope.ref,
    affectedTaskRefs: [program.currentTask.task.ref],
  };
}
