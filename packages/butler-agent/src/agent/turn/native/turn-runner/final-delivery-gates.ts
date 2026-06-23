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
} from "../../../output/final-output-contract.ts";
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
  const groundedText = input.useTools && shouldEnforceGrounding(input.turnInput)
    ? enforceGroundedActionClaims({
        userText: input.userText,
        responseText: textAfterExplicitTools,
        audit: input.audit,
        language: input.deps.messageLanguage,
      })
    : textAfterExplicitTools;
  let finalText = await runGoalCompletionReviews({ ...input, initialText: groundedText });
  finalText = await closeDirectWork({ ...input, finalText });
  finalText = await repairFinalContract({ ...input, finalText });
  await emitTurnEventBestEffort(input.turnInput, {
    kind: "guard.started",
    payload: { guard: "public_output" },
  });
  const checkedText = applyPublicOutputGuards({ ...input, finalText });
  await emitTurnEventBestEffort(input.turnInput, {
    kind: "guard.completed",
    payload: { guard: "public_output", status: "approved" },
  });
  return checkedText;
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
  if (!input.useTools) return text;
  const explicitTools = requiredExplicitToolNames(
    [input.session.init.metadata, input.turnInput.metadata],
    input.toolSurfaceController.initialToolNames(),
  );
  for (let repairAttempt = 0; repairAttempt < 2; repairAttempt += 1) {
    const missingExplicitTools = explicitTools.filter((toolName) =>
      !hasSuccessfulTool(input.audit, [toolName]));
    if (missingExplicitTools.length === 0) break;
    text = await input.runToolPrompt(explicitToolRequirementRepairPrompt({
      prompt: input.prompt,
      previousAnswer: text,
      missingTools: missingExplicitTools,
    }), Math.min(4, missingExplicitTools.length + 2), "explicit_tool_repair");
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
  if (
    input.useTools &&
    shouldEnforceGrounding(input.turnInput) &&
    containsFinalPublicWorkDecisionLeak(finalText) &&
    !input.audit.some((entry) => entry.ok)
  ) {
    finalText = await runGoalCompletionReviewGate(input, finalText, goalCompletionReviewPrompt({
      prompt: input.prompt,
      previousAnswer: finalText,
      audit: input.audit,
      decisions: input.publicDecisionContext,
    }), 4);
  }
  if (!shouldRunModelReview(input)) return finalText;
  finalText = await maybeRunEvidenceReview(input, finalText);
  return await repairCompletionObligations(input, finalText);
}

function shouldRunModelReview(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  useTools: boolean;
  audit: ToolAuditEntry[];
}): boolean {
  return input.useTools &&
    shouldEnforceGrounding(input.turnInput) &&
    shouldRunGoalCompletionReview(input.turnInput.metadata, input.session.init.role) &&
    !hasGoalCompletionReviewSkipTool(input.audit) &&
    input.audit.some((entry) => entry.ok);
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
  if (!shouldRunModelCompletionReview) return finalText;
  return await runGoalCompletionReviewGate(input, finalText, goalCompletionReviewPrompt({
    prompt: input.prompt,
    previousAnswer: finalText,
    audit: input.audit,
    decisions: input.publicDecisionContext,
  }), 4);
}

async function repairCompletionObligations(
  input: Parameters<typeof runGoalCompletionReviews>[0],
  finalText: string,
): Promise<string> {
  const obligationIncompleteReason = completionObligationIncompleteReason({
    audit: input.audit,
    decisions: input.publicDecisionContext,
  });
  if (!obligationIncompleteReason) return finalText;
  const repairedText = await runGoalCompletionReviewGate(input, finalText, goalCompletionReviewPrompt({
    prompt: input.prompt,
    previousAnswer: [`INCOMPLETE: ${obligationIncompleteReason}`, "", "Previous draft:", finalText].join("\n"),
    audit: input.audit,
    decisions: input.publicDecisionContext,
  }), 4);
  const secondObligationIncompleteReason = completionObligationIncompleteReason({
    audit: input.audit,
    decisions: input.publicDecisionContext,
  });
  if (secondObligationIncompleteReason) {
    throw goalCompletionIncompleteError(secondObligationIncompleteReason ?? obligationIncompleteReason);
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
    continuationMaxToolRounds: 8,
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
  if (outcome.kind === "deliverable") return outcome.text;
  throw goalCompletionIncompleteError(outcome.reason);
}
