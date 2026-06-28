import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import {
  enforceGroundedActionClaims,
  explicitToolRequirementRepairPrompt,
  hasSuccessfulTool,
  requiredExplicitToolNames,
  shouldEnforceGrounding,
} from "../../../policy/runtime-policy.ts";
import { evaluateCompletionReviewOutcome } from "../../completion-review.ts";
import { requiredCompletionObligations } from "../../../output/completion/obligation-review.ts";
import {
  goalCompletionContinuationAttempts,
} from "../policy/turn-errors.ts";
import {
  hasGoalCompletionReviewSkipTool,
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
import type { createDirectTurnBudget } from "../../direct-turn-budget.ts";

const EXPLICIT_TOOL_REPAIR_ATTEMPTS = 2;
const EXPLICIT_TOOL_REPAIR_BASE_ROUNDS = 2;
const EXPLICIT_TOOL_REPAIR_MAX_ROUNDS = 4;
const DIRECT_WORK_CONTINUATION_MAX_TOOL_ROUNDS = 8;

export async function produceFinalDeliveryText(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  deps: NativeTurnRunnerDeps;
  useTools: boolean;
  turnId?: string | null;
  turnBudget: ReturnType<typeof createDirectTurnBudget>;
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
  const reviewResult = await runGoalCompletionReviews({ ...input, initialText: groundedText });
  const validationClosedText = await closeUnresolvedValidationWork({ ...input, finalText: reviewResult.reviewedText });
  const directWorkClosedText = reviewResult.outcome.status === "complete"
    ? await closeDirectWork({ ...input, finalText: validationClosedText })
    : validationClosedText;
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
  turnId?: string | null;
  prompt: string;
  initialText: string;
  audit: ToolAuditEntry[];
  publicDecisionContext: PublicWorkDecision[];
  runToolPrompt(promptText: string, maxToolRounds?: number, phase?: string): Promise<string>;
}): Promise<{ outcome: ReturnType<typeof evaluateCompletionReviewOutcome>; reviewedText: string }> {
  const shouldReview = shouldRunCompletionReview(input);
  if (!shouldReview) {
    return {
      outcome: {
        status: "complete",
        evidenceRefs: [],
      },
      reviewedText: input.initialText,
    };
  }
  const outcome = evaluateCompletionReviewOutcome({
    requestText: input.prompt,
    candidateText: input.initialText,
    evidenceReceipts: evidenceCapabilityReceiptsFromAudit(input.audit),
    requiredObligations: requiredCompletionObligations(input.publicDecisionContext),
    observations: [],
    workStreamTerminal: false,
    todoTerminal: false,
  });
  return { outcome, reviewedText: input.initialText };
}

function shouldRunCompletionReview(
  input: {
    turnInput: RuntimeTurnInput;
    session: NativeStoredSessionConfig;
    useTools: boolean;
    audit: ToolAuditEntry[];
  },
): boolean {
  if (!input.useTools || !shouldEnforceGrounding(input.turnInput)) {
    return false;
  }
  if (!shouldRunGoalCompletionReview(input.turnInput.metadata, input.session.init.role)) {
    return false;
  }
  if (hasGoalCompletionReviewSkipTool(input.audit)) {
    return false;
  }
  return input.audit.some((entry) => entry.ok);
}

function evidenceCapabilityReceiptsFromAudit(audit: ToolAuditEntry[]): unknown[] {
  return audit.flatMap((entry) => entry.evidenceCapabilityReceipts ?? []);
}
