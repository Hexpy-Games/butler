import { recordOperationalMetric } from "../../../../operations/metrics/operational-metrics.ts";
import type { RuntimeTurnResult } from "../../../../test-support/harness/contracts.ts";
import { runtimeArtifactsFromAudit } from "../output/runtime-artifacts.ts";
import { emitTurnEventBestEffort } from "../progress/turn-delivery-events.ts";
import {
  isPromptUsageModelCallBudgetError,
  recoverableLimitedDeliveryForError,
} from "../../recoverable-delivery.ts";
import { deliveredWithLimitationsState } from "../../runtime-delivery-state.ts";
import { persistTurnContextAtom } from "../../turn-continuation-context.ts";
import { safeRuntimeFailure } from "../../../../integrations/providers/provider-errors.ts";
import {
  cancelActiveWorkStreamBestEffort,
  completeReportingWorkStreamBestEffort,
  completeRuntimeSemanticWorkStreamBestEffort,
  markActiveWorkStreamRecoverableBestEffort,
} from "./workstream-finalizers.ts";
import {
  emitInterruptedTurnOutcome,
  emitRecoverableTurnOutcome,
  emitSuccessfulTurnOutcome,
} from "./turn-outcome-events.ts";
import { produceFinalDeliveryText } from "./final-delivery-gates.ts";
import { prepareNativeTurnContext } from "./turn-context-builder.ts";
import { createNativeTurnPromptRunners } from "./turn-prompt-runners.ts";
import { runtimePreparationProgressSummary } from "./runtime-preparation-progress.ts";
import { emitRuntimePreparationProgressBestEffort } from "../progress/turn-delivery-events.ts";
import { throwIfRuntimeTurnAborted } from "../policy/turn-errors.ts";
import { unresolvedValidationFailureFromAudit } from "./validation-failure-guard.ts";
import type { PublicWorkDecision, ToolAuditEntry } from "../output/tool-types.ts";
import type { NativeTurnRunnerInput } from "./turn-runner-types.ts";

export async function runNativeToolTurn({
  input,
  session,
  deps,
  startedAt,
}: NativeTurnRunnerInput): Promise<RuntimeTurnResult> {
  throwIfRuntimeTurnAborted(input.signal);
  const useTools = ["butler", "steward", "worker"].includes(session.init.role);
  let turnId: string | undefined;
  try {
    const audit: ToolAuditEntry[] = [];
    const publicDecisionContext: PublicWorkDecision[] = [];
    const pendingPublicDecisions: PublicWorkDecision[] = [];
    const earlyProgressEmitted = useTools
      ? await emitEarlyRuntimePreparationProgress({
          input,
          language: deps.messageLanguage,
        })
      : false;
    const context = await prepareNativeTurnContext({
      turnInput: input,
      session,
      deps,
      startedAt,
      useTools,
      audit,
      publicDecisionContext,
      pendingPublicDecisions,
      skipRuntimePreparationProgress: earlyProgressEmitted,
    });
    turnId = context.turnId;
    const { runToolPrompt, runTextPrompt } = createNativeTurnPromptRunners({
      turnInput: input,
      session,
      deps,
      turnId: context.turnId,
      turnBudget: context.turnBudget,
      promptSections: context.promptSections,
      attachments: context.attachments,
      executor: context.executor,
      toolSurfaceController: context.toolSurfaceController,
      plannedReview: context.plannedReview,
      publicDecisionContext,
      pendingPublicDecisions,
    });
    const initialText = useTools
      ? await runToolPrompt(context.prompt, undefined, "initial_tool_loop")
      : await runTextPrompt(context.prompt);
    throwIfRuntimeTurnAborted(input.signal);
    const decisionCheckedText = await produceFinalDeliveryText({
      turnInput: input,
      session,
      deps,
      useTools,
      prompt: context.prompt,
      userText: context.userText,
      initialText,
      audit,
      publicDecisionContext,
      toolSurfaceController: context.toolSurfaceController,
      runToolPrompt,
      turnId,
      turnBudget: context.turnBudget,
    });
    if (useTools) {
      completeRuntimeSemanticWorkStreamBestEffort({
        butlerData: deps.butlerData,
        sessionId: input.handle.sessionId,
        projectId: projectId(session),
        tracker: context.semanticProgressSafetyNet,
        language: deps.messageLanguage,
        audit,
      });
      completeReportingWorkStreamBestEffort({
        butlerData: deps.butlerData,
        sessionId: input.handle.sessionId,
        turnId,
        audit,
      });
    }
    const delivery = deliveryForFinalAudit(audit);
    await emitFinalEvents(input, decisionCheckedText, audit, delivery, turnId);
    recordTurnMetric({
      status: "ok",
      input,
      session,
      deps,
      startedAt,
      useTools,
      audit,
      publicDecisionContext,
      promptChars: context.prompt.length,
      recallContextChars: context.normalizedPrompt.recallContextChars,
      compactionContextChars: context.normalizedPrompt.compactionContextChars,
      workingMemoryContextChars: context.normalizedPrompt.workingMemoryContextChars,
    });
    return {
      text: decisionCheckedText,
      runtimeSessionRef: input.handle.runtimeSessionRef,
      delivery,
      artifacts: runtimeArtifactsFromAudit({
        audit,
        butlerData: deps.butlerData,
        workspacePath: session.init.workspacePath,
      }),
    };
  } catch (error) {
    const limitedDelivery = recoverableLimitedDeliveryForError(error);
    const isBudgetError = isPromptUsageModelCallBudgetError(error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (isBudgetError && turnId) {
      const safeFailure = safeRuntimeFailure(error);
      persistTurnContextAtom({
        butlerData: deps.butlerData,
        sessionId: input.handle.sessionId,
        turnId,
        state: "continuing",
        sourceErrorCode: safeFailure.code,
        reason: safeFailure.message,
        unresolvedObservations: [],
      });
    }
    if (useTools) {
      if (input.signal?.aborted) {
        cancelActiveWorkStreamBestEffort({
          butlerData: deps.butlerData,
          sessionId: input.handle.sessionId,
          turnId,
        });
      } else {
        const recoveryStreams = isBudgetError
          ? []
          : markActiveWorkStreamRecoverableBestEffort({
            butlerData: deps.butlerData,
            sessionId: input.handle.sessionId,
            turnId,
            reason: limitedDelivery?.reason ?? errorMessage,
          });
        if (limitedDelivery && !isBudgetError) {
          await emitRecoverableTurnOutcome({
            turnInput: input,
            turnId,
            reason: errorMessage,
            workStreamId: recoveryStreams.at(0)?.id,
            todoListId: recoveryStreams.at(0)?.todo_list_id ?? undefined,
          });
        }
      }
    }
    if (!limitedDelivery && !isBudgetError) {
      await emitInterruptedTurnOutcome({
        turnInput: input,
        cancelled: Boolean(input.signal?.aborted),
        reason: errorMessage,
      });
      await emitTurnEventBestEffort(input, {
        kind: input.signal?.aborted ? "turn.cancelled" : "turn.failed",
        payload: { safeLabel: input.signal?.aborted ? "Cancelled" : "Failed" },
      });
    }
    recordTurnMetric({
      status: "error",
      input,
      session,
      deps,
      startedAt,
      useTools,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  }
}

async function emitEarlyRuntimePreparationProgress(input: {
  input: NativeTurnRunnerInput["input"];
  language: NativeTurnRunnerInput["deps"]["messageLanguage"];
}): Promise<boolean> {
  try {
    await emitRuntimePreparationProgressBestEffort({
      turnInput: input.input,
      progress: runtimePreparationProgressSummary({
        model: input.input.model,
        language: input.language,
        useTools: true,
        userText: currentUserText(input.input),
      }),
    });
    return true;
  } catch {
    return false;
  }
}

function deliveryForFinalAudit(audit: ToolAuditEntry[]): RuntimeTurnResult["delivery"] {
  const validationFailure = unresolvedValidationFailureFromAudit(audit);
  if (!validationFailure) return undefined;
  const limitation = `Validation suite failed without a later passing receipt: ${validationFailure.suite}`;
  return deliveredWithLimitationsState({
    limitationCodes: ["validation_failed"],
    limitations: [limitation],
  });
}

async function emitFinalEvents(
  input: NativeTurnRunnerInput["input"],
  text: string,
  audit: ToolAuditEntry[],
  delivery?: RuntimeTurnResult["delivery"],
  turnId?: string,
): Promise<void> {
  const limitedDelivery = delivery?.delivery_state === "delivered_with_limitations";
  await emitSuccessfulTurnOutcome({
    turnInput: input,
    audit,
    limitedDelivery,
    turnId,
  });
  await emitTurnEventBestEffort(input, {
    kind: "message.final.started",
    payload: { safeLabel: "Preparing final answer" },
  });
  await emitTurnEventBestEffort(input, {
    kind: "message.final.completed",
    payload: {
      safeLabel: limitedDelivery ? "Final answer ready with limitations" : "Final answer ready",
      textChars: text.length,
      ...(delivery ?? {}),
    },
  });
  await emitTurnEventBestEffort(input, {
    kind: "turn.completed",
    payload: {
      safeLabel: limitedDelivery ? "Completed with limitations" : "Completed",
      ...(delivery ?? {}),
    },
  });
}

function recordTurnMetric(input: {
  status: "ok" | "error";
  input: NativeTurnRunnerInput["input"];
  session: NativeTurnRunnerInput["session"];
  deps: NativeTurnRunnerInput["deps"];
  startedAt: number;
  useTools: boolean;
  audit?: ToolAuditEntry[];
  publicDecisionContext?: PublicWorkDecision[];
  promptChars?: number;
  recallContextChars?: number;
  compactionContextChars?: number;
  workingMemoryContextChars?: number;
  errorName?: string;
}): void {
  recordOperationalMetric({
    category: "runtime",
    name: "turn",
    status: input.status,
    durationMs: Date.now() - input.startedAt,
    dimensions: {
      role: input.session.init.role,
      runtime: input.deps.runtimeId,
      model: input.input.model,
      ...(input.status === "error" ? { errorName: input.errorName ?? "UnknownError" } : {
        useTools: input.useTools,
        toolCalls: input.audit?.length ?? 0,
        publicDecisions: input.publicDecisionContext?.length ?? 0,
        publicDecisionAssistantAuthored:
          input.publicDecisionContext?.filter((decision) => decision.source === "assistant-authored").length ?? 0,
        publicDecisionRuntimeDerived:
          input.publicDecisionContext?.filter((decision) => decision.source === "runtime-derived").length ?? 0,
        recallContextChars: input.recallContextChars ?? 0,
        compactionContextChars: input.compactionContextChars ?? 0,
        workingMemoryContextChars: input.workingMemoryContextChars ?? 0,
        promptChars: input.promptChars ?? 0,
      }),
    },
  }, { butlerData: input.deps.butlerData });
}

function projectId(session: NativeTurnRunnerInput["session"]): string | undefined {
  return typeof session.init.metadata?.projectId === "string"
    ? session.init.metadata.projectId
    : undefined;
}

function currentUserText(input: NativeTurnRunnerInput["input"]): string {
  if ("eventId" in input.input) return input.input.message.text ?? "";
  return input.input.text ?? "";
}
