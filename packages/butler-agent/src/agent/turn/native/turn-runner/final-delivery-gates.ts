import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import {
  activeDirectWorkProgressSnapshot,
  turnAdvancedDuringToolPrompt,
  type DirectWorkProgressSnapshot,
} from "../../direct-work-continuation.ts";
import { CompletionReviewOrchestrator } from "../../completion-review-orchestrator.ts";
import {
  enforceGroundedActionClaims,
  explicitToolRequirementRepairPrompt,
  hasSuccessfulTool,
  requiredExplicitToolNames,
  shouldEnforceGrounding,
} from "../../../policy/runtime-policy.ts";
import {
  completionObligationIncompleteReason,
  containsFinalPublicWorkDecisionLeak,
  containsFinalToolImplementationLeak,
  completionReviewIncompleteReason,
  goalCompletionIncompleteContinuationPrompt,
  goalCompletionReviewPrompt,
} from "../../../output/completion/final-output-contract.ts";
import {
  progressFinalizationText,
} from "../../../output/completion/progress-finalization.ts";
import {
  goalCompletionContinuationAttempts,
  goalCompletionIncompleteError,
} from "../policy/turn-errors.ts";
import {
  hasGoalCompletionReviewSkipTool,
  hasPendingReadRequirement,
  hasVerifiedEvidenceReceipt,
} from "../policy/turn-evidence-gates.ts";
import { shouldRunGoalCompletionReview } from "../policy/turn-metadata-policy.ts";
import type { NativeStoredSessionConfig, NativeTurnRunnerDeps } from "./turn-runner-types.ts";
import type { PublicWorkDecision, ToolAuditEntry } from "../output/tool-types.ts";
import type { ToolSurfacePromptController } from "../../tool-surface-prompt-controller.ts";
import { closeDirectWork } from "./direct-work-finalizer.ts";
import {
  applyPublicOutputGuards,
  repairFinalContract,
} from "./public-output-gates.ts";
import { emitTurnEventBestEffort } from "../progress/turn-delivery-events.ts";
import {
  unresolvedValidationFailureFromAudit,
  validationFailureContinuationPrompt,
} from "./validation-failure-guard.ts";

const EXPLICIT_TOOL_REPAIR_ATTEMPTS = 2;
const EXPLICIT_TOOL_REPAIR_BASE_ROUNDS = 2;
const EXPLICIT_TOOL_REPAIR_MAX_ROUNDS = 4;
const GOAL_REVIEW_MAX_TOOL_ROUNDS = 4;
const DIRECT_WORK_CONTINUATION_MAX_TOOL_ROUNDS = 8;

export async function produceFinalDeliveryText(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  deps: NativeTurnRunnerDeps;
  useTools: boolean;
  prompt: string;
  userText: string;
  initialText: string;
  audit: ToolAuditEntry[];
  publicDecisionContext: PublicWorkDecision[];
  toolSurfaceController: ToolSurfacePromptController;
  runToolPrompt(promptText: string, maxToolRounds?: number, phase?: string): Promise<string>;
}): Promise<string> {
  const textAfterExplicitTools = await repairExplicitToolRequirements(input);
  const groundedText = applyGroundingIfNeeded(input, textAfterExplicitTools);
  const reviewedText = await runGoalCompletionReviews({ ...input, initialText: groundedText });
  const validationClosedText = await closeUnresolvedValidationWork({ ...input, finalText: reviewedText });
  const directWorkClosedText = await closeDirectWork({ ...input, finalText: validationClosedText });
  const contractRepairedText = await repairFinalContract({ ...input, finalText: directWorkClosedText });
  await emitTurnEventBestEffort(input.turnInput, {
    kind: "guard.started",
    payload: { guard: "public_output" },
  });
  const checkedText = applyPublicOutputGuards({ ...input, finalText: contractRepairedText });
  await emitTurnEventBestEffort(input.turnInput, {
    kind: "guard.completed",
    payload: { guard: "public_output", status: "approved" },
  });
  return checkedText;
}

async function closeUnresolvedValidationWork(input: {
  prompt: string;
  finalText: string;
  audit: ToolAuditEntry[];
  runToolPrompt(promptText: string, maxToolRounds?: number, phase?: string): Promise<string>;
}): Promise<string> {
  let finalText = input.finalText;
  for (let attempt = 0; attempt < goalCompletionContinuationAttempts(); attempt += 1) {
    const failure = unresolvedValidationFailureFromAudit(input.audit);
    if (!failure) return finalText;
    finalText = await input.runToolPrompt(validationFailureContinuationPrompt({
      objective: input.prompt,
      previousAnswer: finalText,
      failure,
    }), DIRECT_WORK_CONTINUATION_MAX_TOOL_ROUNDS, "validation_failure_continuation");
  }
  return finalText;
}

function applyGroundingIfNeeded(
  input: {
    turnInput: RuntimeTurnInput;
    deps: NativeTurnRunnerDeps;
    useTools: boolean;
    userText: string;
    audit: ToolAuditEntry[];
  },
  text: string,
): string {
  const shouldApplyGrounding = input.useTools && shouldEnforceGrounding(input.turnInput);
  if (!shouldApplyGrounding) {
    return text;
  }
  return enforceGroundedActionClaims({
    userText: input.userText,
    responseText: text,
    audit: input.audit,
    language: input.deps.messageLanguage,
  });
}

async function repairExplicitToolRequirements(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  useTools: boolean;
  prompt: string;
  initialText: string;
  audit: ToolAuditEntry[];
  toolSurfaceController: ToolSurfacePromptController;
  runToolPrompt(promptText: string, maxToolRounds?: number, phase?: string): Promise<string>;
}): Promise<string> {
  let text = input.initialText;
  if (!input.useTools) {
    return text;
  }
  const explicitTools = requiredExplicitToolNames(
    [input.session.init.metadata, input.turnInput.metadata],
    input.toolSurfaceController.initialToolNames(),
  );
  for (let repairAttempt = 0; repairAttempt < EXPLICIT_TOOL_REPAIR_ATTEMPTS; repairAttempt += 1) {
    const missingExplicitTools = explicitTools.filter((toolName) =>
      !hasSuccessfulTool(input.audit, [toolName]));
    if (missingExplicitTools.length === 0) {
      break;
    }
    const repairMaxToolRounds = Math.min(
      EXPLICIT_TOOL_REPAIR_MAX_ROUNDS,
      missingExplicitTools.length + EXPLICIT_TOOL_REPAIR_BASE_ROUNDS,
    );
    text = await input.runToolPrompt(explicitToolRequirementRepairPrompt({
      prompt: input.prompt,
      previousAnswer: text,
      missingTools: missingExplicitTools,
    }), repairMaxToolRounds, "explicit_tool_repair");
  }
  return text;
}

async function runGoalCompletionReviews(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  deps: NativeTurnRunnerDeps;
  useTools: boolean;
  prompt: string;
  initialText: string;
  audit: ToolAuditEntry[];
  publicDecisionContext: PublicWorkDecision[];
  runToolPrompt(promptText: string, maxToolRounds?: number, phase?: string): Promise<string>;
}): Promise<string> {
  let finalText = input.initialText;
  const hasSuccessfulToolAudit = input.audit.some((entry) => entry.ok);
  const shouldRepairDecisionLeakBeforeReview = input.useTools &&
    shouldEnforceGrounding(input.turnInput) &&
    containsFinalPublicWorkDecisionLeak(finalText) &&
    !hasSuccessfulToolAudit;
  if (shouldRepairDecisionLeakBeforeReview) {
    finalText = await runGoalCompletionReviewGate(input, finalText, goalCompletionReviewPrompt({
      prompt: input.prompt,
      previousAnswer: finalText,
      audit: input.audit,
      decisions: input.publicDecisionContext,
    }), GOAL_REVIEW_MAX_TOOL_ROUNDS);
  }
  if (!shouldRunModelReview(input)) {
    return finalText;
  }
  finalText = await maybeRunEvidenceReview(input, finalText);
  return await repairCompletionObligations(input, finalText);
}

function shouldRunModelReview(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  useTools: boolean;
  audit: ToolAuditEntry[];
}): boolean {
  const shouldEnforceRuntimeGrounding = shouldEnforceGrounding(input.turnInput);
  const roleRequiresReview = shouldRunGoalCompletionReview(input.turnInput.metadata, input.session.init.role);
  const hasReviewSkipTool = hasGoalCompletionReviewSkipTool(input.audit);
  const hasSuccessfulToolAudit = input.audit.some((entry) => entry.ok);
  return input.useTools &&
    shouldEnforceRuntimeGrounding &&
    roleRequiresReview &&
    !hasReviewSkipTool &&
    hasSuccessfulToolAudit;
}

async function maybeRunEvidenceReview(
  input: Parameters<typeof runGoalCompletionReviews>[0],
  finalText: string,
): Promise<string> {
  const successfulToolNamesForReview = input.audit.filter((entry) => entry.ok).map((entry) => entry.name);
  const preReviewObligationIncompleteReason = completionObligationIncompleteReason({
    audit: input.audit,
    decisions: input.publicDecisionContext,
  });
  const preReviewNeedsContractRepair =
    containsFinalPublicWorkDecisionLeak(finalText) ||
    containsFinalToolImplementationLeak(finalText, successfulToolNamesForReview);
  const shouldRunModelCompletionReview =
    !hasVerifiedEvidenceReceipt(input.audit) ||
    hasPendingReadRequirement(input.audit) ||
    Boolean(preReviewObligationIncompleteReason) ||
    preReviewNeedsContractRepair;
  if (!shouldRunModelCompletionReview) {
    return finalText;
  }
  return await runGoalCompletionReviewGate(input, finalText, goalCompletionReviewPrompt({
    prompt: input.prompt,
    previousAnswer: finalText,
    audit: input.audit,
    decisions: input.publicDecisionContext,
  }), GOAL_REVIEW_MAX_TOOL_ROUNDS);
}

async function repairCompletionObligations(
  input: Parameters<typeof runGoalCompletionReviews>[0],
  finalText: string,
): Promise<string> {
  const obligationIncompleteReason = completionObligationIncompleteReason({
    audit: input.audit,
    decisions: input.publicDecisionContext,
  });
  if (!obligationIncompleteReason) {
    return finalText;
  }
  const repairedText = await runGoalCompletionReviewGate(input, finalText, goalCompletionReviewPrompt({
    prompt: input.prompt,
    previousAnswer: [`INCOMPLETE: ${obligationIncompleteReason}`, "", "Previous draft:", finalText].join("\n"),
    audit: input.audit,
    decisions: input.publicDecisionContext,
  }), GOAL_REVIEW_MAX_TOOL_ROUNDS);
  const secondObligationIncompleteReason = completionObligationIncompleteReason({
    audit: input.audit,
    decisions: input.publicDecisionContext,
  });
  if (secondObligationIncompleteReason) {
    throw goalCompletionIncompleteError(
      secondObligationIncompleteReason,
      progressFinalizationText({
        language: input.deps.messageLanguage,
        previousAnswer: repairedText,
        audit: input.audit,
        decisions: input.publicDecisionContext,
        reason: secondObligationIncompleteReason,
      }),
    );
  }
  return repairedText;
}

async function runGoalCompletionReviewGate(
  input: {
    turnInput: RuntimeTurnInput;
    deps: NativeTurnRunnerDeps;
    prompt: string;
    audit: ToolAuditEntry[];
    publicDecisionContext: PublicWorkDecision[];
    runToolPrompt(promptText: string, maxToolRounds?: number, phase?: string): Promise<string>;
  },
  currentFinalText: string,
  reviewPromptText: string,
  maxToolRounds: number,
): Promise<string> {
  const successfulToolAuditCount = () => input.audit.filter((entry) => entry.ok).length;
  const outcome = await new CompletionReviewOrchestrator<DirectWorkProgressSnapshot>().run({
    currentFinalText,
    initialReviewPromptText: reviewPromptText,
    reviewMaxToolRounds: maxToolRounds,
    continuationMaxToolRounds: DIRECT_WORK_CONTINUATION_MAX_TOOL_ROUNDS,
    maxContinuationAttempts: goalCompletionContinuationAttempts(),
    runToolPrompt: input.runToolPrompt,
    incompleteReason: completionReviewIncompleteReason,
    buildContinuationPrompt: ({ previousAnswer, incompleteReason }) =>
      goalCompletionIncompleteContinuationPrompt({
        prompt: input.prompt,
        previousAnswer,
        incompleteReason,
        audit: input.audit,
        decisions: input.publicDecisionContext,
      }),
    buildReviewPrompt: ({ candidateFinalText }) => goalCompletionReviewPrompt({
      prompt: input.prompt,
      previousAnswer: candidateFinalText,
      audit: input.audit,
      decisions: input.publicDecisionContext,
    }),
    captureProgress: () => ({
      progress: activeDirectWorkProgressSnapshot({
        butlerData: input.deps.butlerData,
        sessionId: input.turnInput.handle.sessionId,
      }),
      successfulToolCount: successfulToolAuditCount(),
    }),
    didProgressAdvance: (before, after) => turnAdvancedDuringToolPrompt({
      beforeWork: before.progress,
      afterWork: after.progress,
      successfulToolsBefore: before.successfulToolCount,
      successfulToolsAfter: after.successfulToolCount,
    }),
  });
  if (outcome.kind === "deliverable") {
    return outcome.text;
  }
  throw goalCompletionIncompleteError(
    outcome.reason,
    progressFinalizationText({
      language: input.deps.messageLanguage,
      previousAnswer: currentFinalText,
      audit: input.audit,
      decisions: input.publicDecisionContext,
      reason: outcome.reason,
    }),
  );
}
