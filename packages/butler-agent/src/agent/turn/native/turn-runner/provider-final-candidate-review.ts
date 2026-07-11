import type { FunctionToolPromptOptions } from "../../../../integrations/providers/provider.ts";
import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import type { createDirectTurnBudget } from "../../direct-turn-budget.ts";
import type { ToolSurfacePromptController } from "../../tool-surface-prompt-controller.ts";
import type { PublicWorkDecision, ToolAuditEntry } from "../output/tool-types.ts";
import { emitTurnEventBestEffort } from "../progress/turn-delivery-events.ts";
import { buildTurnContinuationEvidence } from "./turn-continuation-evidence.ts";
import {
  completionGapContinuationPrompt,
  completionGapFinalSynthesisPrompt,
} from "./turn-continuation-prompts.ts";
import {
  reviewFinalCandidateForContinuation,
} from "./final-delivery-gates.ts";
import {
  resumeTurnContractExecution,
  type ActiveTurnContract,
} from "./turn-contract-runtime.ts";
import type { NativeStoredSessionConfig, NativeTurnRunnerDeps } from "./turn-runner-types.ts";

export async function reviewProviderFinalCandidateInTurn(input: {
  candidateText: string;
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  deps: NativeTurnRunnerDeps;
  useTools: boolean;
  turnId: string;
  turnBudget: ReturnType<typeof createDirectTurnBudget>;
  prompt: string;
  userText: string;
  audit: ToolAuditEntry[];
  publicDecisionContext: PublicWorkDecision[];
  toolSurfaceController: ToolSurfacePromptController;
  activeTurnContract: ActiveTurnContract | null;
}): Promise<Awaited<ReturnType<NonNullable<FunctionToolPromptOptions["reviewFinalCandidate"]>>>> {
  const review = await reviewFinalCandidateForContinuation({
    turnInput: input.turnInput,
    session: input.session,
    deps: input.deps,
    useTools: input.useTools,
    turnId: input.turnId,
    turnBudget: input.turnBudget,
    prompt: input.prompt,
    userText: input.userText,
    initialText: input.candidateText,
    audit: input.audit,
    publicDecisionContext: input.publicDecisionContext,
    toolSurfaceController: input.toolSurfaceController,
    turnContract: input.activeTurnContract?.contract,
  });
  if (review.kind === "accepted") {
    return { status: "accepted", text: review.text };
  }

  await emitTurnEventBestEffort(input.turnInput, {
    kind: "turn.observation",
    visibility: "internal",
    payload: {
      kind: review.observation.kind,
      safeLabel: review.observation.summary,
      modelVisibleContentChars: review.observation.modelVisibleContent.length,
    },
  });
  if (input.activeTurnContract && review.observation.nextMode !== "final_synthesis") {
    input.activeTurnContract.contract = resumeTurnContractExecution({
      butlerData: input.deps.butlerData,
      active: input.activeTurnContract,
    });
  }
  const continuationEvidence = buildTurnContinuationEvidence({
    audit: input.audit,
    publicDecisions: input.publicDecisionContext,
  });
  const continuation = {
    userText: input.userText,
    activeTurnContract: input.activeTurnContract,
    observationSummary: review.observation.summary,
    modelVisibleContent: review.observation.modelVisibleContent,
    continuationEvidence: continuationEvidence.modelVisibleContent,
  };
  return {
    status: "continue",
    observation: review.observation.nextMode === "final_synthesis"
      ? completionGapFinalSynthesisPrompt(continuation)
      : completionGapContinuationPrompt(continuation),
    requiredDeliverables: review.observation.requiredDeliverables,
  };
}
