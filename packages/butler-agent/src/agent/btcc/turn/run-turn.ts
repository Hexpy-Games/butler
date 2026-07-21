import {
  conceiveCorrection,
  deliberateGoal,
  openConception,
  reviewGoalContract,
} from "../conception/index.ts";
import { assureOriginalGoal } from "../consolidation/index.ts";
import type {
  BtccRuntimeDependencies,
  BtccTurnCommand,
  BtccTurnOutcome,
} from "../contracts.ts";
import type { PhaseInvocation } from "../core/index.ts";
import { insertCanonicalMessage } from "../delivery/index.ts";
import { performTask } from "../execution/index.ts";
import {
  proposeCorrectionOrRevision,
  proposePlan,
  reviewCorrection,
  reviewPlan,
} from "../planning/index.ts";
import { prepareReport } from "../reporting/index.ts";
import { reviewTask } from "../review/index.ts";
import { selectNextTaskOrClose } from "../work/index.ts";
import { admitTurn } from "./admission/index.ts";
import { decideTransition } from "./state-machine/index.ts";
import type {
  StateExecutionClaim,
  TurnEvent,
  TurnRecord,
} from "./contracts.ts";

type RunCommand = Exclude<BtccTurnCommand, { kind: "stop" }>;

export async function runTurn(
  command: RunCommand,
  dependencies: BtccRuntimeDependencies,
): Promise<BtccTurnOutcome> {
  let turn = await loadOrAdmitTurn(command, dependencies);
  while (turn.semanticState !== "delivered" && turn.semanticState !== "cancelled") {
    const claim = await dependencies.turns.acquireStateExecutionClaim(turn);
    const event = await runCurrentPhase(turn, claim, dependencies);
    const transition = decideTransition(turn, event);
    await dependencies.turns.commitTransition({ turn, claim, transition });
    turn = await loadRequiredTurn(turn.turnId, dependencies);
  }
  return projectTerminalOutcome(turn);
}

async function loadOrAdmitTurn(
  command: RunCommand,
  dependencies: BtccRuntimeDependencies,
): Promise<TurnRecord> {
  if (command.kind === "wake") {
    throw new Error("BTCC fresh continuation wake admission is not implemented");
  }
  const existing = await dependencies.turns.findTurn(command.turnId);
  if (existing) {
    if (command.kind === "run") assertExactRunReplay(existing, command);
    return existing;
  }
  if (command.kind !== "run") {
    throw new Error(`BTCC Turn is not admitted: ${command.turnId}`);
  }
  return admitTurn(command, dependencies.admission, dependencies.turns);
}

function assertExactRunReplay(
  turn: TurnRecord,
  command: Extract<BtccTurnCommand, { kind: "run" }>,
): void {
  if (
    turn.sessionId !== command.sessionId ||
    turn.triggerKey !== command.triggerKey ||
    turn.originalMessageId !== command.message.messageId ||
    turn.originalMessage !== command.message.content ||
    canonicalJson(turn.modelSelection) !== canonicalJson(command.modelSelection) ||
    canonicalJson(turn.context) !== canonicalJson(command.context)
  ) {
    throw new Error(`BTCC run replay does not match admitted Turn: ${turn.turnId}`);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

async function runCurrentPhase(
  turn: TurnRecord,
  claim: StateExecutionClaim,
  dependencies: BtccRuntimeDependencies,
): Promise<TurnEvent> {
  switch (turn.semanticState) {
    case "admitted":
      return { kind: "TurnActivated" };
    case "conception_opening": {
      const product = await openConception({
        binding: {
          turnId: turn.turnId,
          turnRevision: turn.revision,
          semanticState: "conception_opening",
          checkpointId: claim.checkpointId,
          checkpointRevision: claim.checkpointRevision,
          claimId: claim.claimId,
          executionFence: claim.executionFence,
        },
        modelSelection: turn.modelSelection,
        context: {
          originalMessageId: turn.originalMessageId,
          originalMessage: turn.originalMessage,
          ...turn.context,
        },
        conversations: dependencies.phaseConversations,
        model: dependencies.model,
      });
      return product.kind === "opening_answer"
        ? { kind: "OpeningAnswerAccepted", product }
        : { kind: "OpeningContinuationAccepted", product };
    }
    case "conception_deliberation": {
      const product = await deliberateGoal(phaseInvocation(turn, claim, dependencies));
      return { kind: "GoalContractCandidateSubmitted", product };
    }
    case "contract_review": {
      const product = await reviewGoalContract(phaseInvocation(turn, claim, dependencies, {
        sessionId: turn.sessionId,
        goalCandidate: requiredManaged(turn).goalCandidate,
      }));
      return { kind: "GoalContractReviewAccepted", product };
    }
    case "planning": {
      const accepted = requiredManaged(turn).goalAcceptance;
      if (!accepted) throw new Error("Planning is missing accepted Goal authority");
      const product = await proposePlan(phaseInvocation(turn, claim, dependencies, {
        goalContractRef: accepted.goalContract.ref,
        authorityRef: accepted.authority.ref,
        requiredOutcomeId: accepted.goalContract.requiredOutcome.outcomeId,
        ledgerId: accepted.authority.managedBinding.ledgerId,
        programId: accepted.authority.managedBinding.programId,
      }));
      return { kind: "PlanCandidateSubmitted", product };
    }
    case "planning_review": {
      const product = await reviewPlan(phaseInvocation(turn, claim, dependencies, {
        planCandidate: requiredManaged(turn).planCandidate,
      }));
      return { kind: "PlanningReviewAccepted", product };
    }
    case "work_frontier": {
      const decision = selectNextTaskOrClose({
        turnId: turn.turnId,
        turnRevision: turn.revision,
        program: requiredProgram(turn),
      });
      return decision.kind === "select_task"
        ? { kind: "WorkTaskSelected", attempt: decision.attempt }
        : { kind: "WorkFrontierClosed" };
    }
    case "task_execution": {
      const program = requiredProgram(turn);
      const attempt = requiredCurrentAttempt(program);
      const product = await performTask(phaseInvocation(turn, claim, dependencies, {
        goalContractRef: program.goalContractRef,
        authorityRef: program.authorityRef,
        workRef: program.work.ref,
        taskRef: program.task.ref,
        attemptRef: attempt.ref,
        executionTargetRef: attempt.executionTargetRef,
      }));
      return { kind: "ResultCandidateSubmitted", product };
    }
    case "task_review": {
      const program = requiredProgram(turn);
      const product = await reviewTask(phaseInvocation(turn, claim, dependencies, {
        resultCandidate: program.currentResult,
        criterionRef: program.criterion.ref,
      }));
      return product.review.verdict === "passed"
        ? { kind: "TaskReviewPassed", product }
        : { kind: "TaskReviewFailed", product };
    }
    case "feedback_conception": {
      const program = requiredProgram(turn);
      const review = program.currentReview;
      if (!review || review.review.verdict !== "not_passed") {
        throw new Error("Feedback Conception requires a failed Task Review");
      }
      const product = await conceiveCorrection(phaseInvocation(turn, claim, dependencies, {
        correctionScopeRef: review.review.correctionScopeRef,
        goalContractRef: program.goalContractRef,
        authorityRef: program.authorityRef,
      }));
      return { kind: "FeedbackIntentAccepted", product };
    }
    case "feedback_planning": {
      const managed = requiredManaged(turn);
      const program = requiredProgram(turn);
      const product = await proposeCorrectionOrRevision(phaseInvocation(turn, claim, dependencies, {
        feedbackIntent: managed.feedbackIntent,
        workPlanRef: program.plan.ref,
        taskRef: program.task.ref,
        artifactLifecycleRef: program.artifactLifecycle.ref,
      }));
      return { kind: "FeedbackPlanCandidateSubmitted", product };
    }
    case "feedback_planning_review": {
      const managed = requiredManaged(turn);
      const program = requiredProgram(turn);
      const product = await reviewCorrection(phaseInvocation(turn, claim, dependencies, {
        feedbackPlan: managed.feedbackPlan,
        goalContractRef: program.goalContractRef,
      }));
      return { kind: "FeedbackPlanningReviewAccepted", product };
    }
    case "consolidation": {
      const program = requiredProgram(turn);
      const review = program.currentReview;
      if (!review || review.review.verdict !== "passed") {
        throw new Error("Consolidation requires the current passed Task Review");
      }
      const product = await assureOriginalGoal(phaseInvocation(turn, claim, dependencies, {
        frontier: program.frontier,
        taskStatus: program.taskStatus,
        programId: program.programId,
        goalContractRef: program.goalContractRef,
        authorityRef: program.authorityRef,
        planRef: program.plan.ref,
        planningReviewRef: program.planningReviewRef,
        taskReviewRef: review.review.ref,
      }));
      return { kind: "FinalDossierAccepted", product };
    }
    case "reporting": {
      const product = await prepareReport(phaseInvocation(turn, claim, dependencies, {
        finalDossier: requiredManaged(turn).finalDossier,
      }));
      return { kind: "PreparedReportAccepted", product };
    }
    case "delivery_committed": {
      const observation = await insertCanonicalMessage({
        turn,
        messages: dependencies.messages,
      });
      return { kind: "DeliveryObserved", assistantMessageId: observation.messageId };
    }
    case "delivered":
    case "cancelled":
      throw new Error(`Terminal BTCC state cannot be dispatched: ${turn.semanticState}`);
  }
}

async function loadRequiredTurn(
  turnId: string,
  dependencies: BtccRuntimeDependencies,
): Promise<TurnRecord> {
  const turn = await dependencies.turns.findTurn(turnId);
  if (!turn) throw new Error(`BTCC Turn disappeared after commit: ${turnId}`);
  return turn;
}

function projectTerminalOutcome(turn: TurnRecord): BtccTurnOutcome {
  if (turn.semanticState === "cancelled") {
    return { kind: "cancelled", turnId: turn.turnId };
  }
  if (!turn.canonicalAssistantMessageId || !turn.finalPayload) {
    throw new Error("Delivered BTCC Turn is missing its canonical delivery");
  }
  return {
    kind: "delivered",
    turnId: turn.turnId,
    messageId: turn.canonicalAssistantMessageId,
    content: turn.finalPayload.content,
  };
}

function phaseInvocation(
  turn: TurnRecord,
  claim: StateExecutionClaim,
  dependencies: BtccRuntimeDependencies,
  stateInput?: unknown,
): PhaseInvocation {
  return {
    binding: {
      turnId: turn.turnId,
      turnRevision: turn.revision,
      semanticState: claim.semanticState as PhaseInvocation["binding"]["semanticState"],
      checkpointId: claim.checkpointId,
      checkpointRevision: claim.checkpointRevision,
      claimId: claim.claimId,
      executionFence: claim.executionFence,
    },
    modelSelection: turn.modelSelection,
    context: {
      originalMessageId: turn.originalMessageId,
      originalMessage: turn.originalMessage,
      ...turn.context,
      ...(stateInput === undefined ? {} : { stateInput }),
    },
    store: dependencies.phaseConversations,
    model: dependencies.model,
  };
}

function requiredManaged(turn: TurnRecord) {
  if (!turn.managed) throw new Error(`Managed BTCC state is missing at ${turn.semanticState}`);
  return turn.managed;
}

function requiredProgram(turn: TurnRecord) {
  const program = requiredManaged(turn).program;
  if (!program) throw new Error(`Managed Program is missing at ${turn.semanticState}`);
  return program;
}

function requiredCurrentAttempt(program: ReturnType<typeof requiredProgram>) {
  const attempt = program.attempts.at(-1);
  if (!attempt || attempt.status !== "ready") {
    throw new Error("Task Execution requires the current ready Attempt");
  }
  return attempt;
}
