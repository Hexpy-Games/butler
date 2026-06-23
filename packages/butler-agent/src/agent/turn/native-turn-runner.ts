import { recordOperationalMetric } from "../../operations/metrics/operational-metrics.ts";
import type { RuntimeTurnResult } from "../../test-support/harness/contracts.ts";
import { runtimeArtifactsFromAudit } from "./native-runtime-artifacts.ts";
import { emitTurnEventBestEffort } from "./native-turn-delivery-events.ts";
import {
  completeReportingWorkStreamBestEffort,
  completeRuntimeSemanticWorkStreamBestEffort,
  markActiveWorkStreamRecoverableBestEffort,
} from "./native-workstream-finalizers.ts";
import { produceFinalDeliveryText } from "./native-final-delivery-gates.ts";
import { prepareNativeTurnContext } from "./native-turn-context-builder.ts";
import { createNativeTurnPromptRunners } from "./native-turn-prompt-runners.ts";
import { throwIfRuntimeTurnAborted } from "./native-turn-errors.ts";
import type { PublicWorkDecision, ToolAuditEntry } from "./native-tool-types.ts";
import type { NativeTurnRunnerInput } from "./native-turn-runner-types.ts";

export async function runNativeToolTurn({
  input,
  session,
  deps,
  startedAt,
}: NativeTurnRunnerInput): Promise<RuntimeTurnResult> {
  throwIfRuntimeTurnAborted(input.signal);
  const useTools = ["butler", "steward", "worker"].includes(session.init.role);
  try {
    const audit: ToolAuditEntry[] = [];
    const publicDecisionContext: PublicWorkDecision[] = [];
    const pendingPublicDecisions: PublicWorkDecision[] = [];
    const context = await prepareNativeTurnContext({
      turnInput: input,
      session,
      deps,
      useTools,
      audit,
      publicDecisionContext,
      pendingPublicDecisions,
    });
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
    });
    if (useTools) {
      completeRuntimeSemanticWorkStreamBestEffort({
        butlerData: deps.butlerData,
        sessionId: input.handle.sessionId,
        projectId: projectId(session),
        tracker: context.semanticProgressSafetyNet,
        language: deps.messageLanguage,
      });
      completeReportingWorkStreamBestEffort({
        butlerData: deps.butlerData,
        sessionId: input.handle.sessionId,
      });
    }
    await emitFinalEvents(input, decisionCheckedText);
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
      artifacts: runtimeArtifactsFromAudit({
        audit,
        butlerData: deps.butlerData,
        workspacePath: session.init.workspacePath,
      }),
    };
  } catch (error) {
    if (useTools && !input.signal?.aborted) {
      markActiveWorkStreamRecoverableBestEffort({
        butlerData: deps.butlerData,
        sessionId: input.handle.sessionId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    await emitTurnEventBestEffort(input, {
      kind: input.signal?.aborted ? "turn.cancelled" : "turn.failed",
      payload: { safeLabel: input.signal?.aborted ? "Cancelled" : "Failed" },
    });
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

async function emitFinalEvents(input: NativeTurnRunnerInput["input"], text: string): Promise<void> {
  await emitTurnEventBestEffort(input, {
    kind: "message.final.started",
    payload: { safeLabel: "Preparing final answer" },
  });
  await emitTurnEventBestEffort(input, {
    kind: "message.final.completed",
    payload: {
      safeLabel: "Final answer ready",
      textChars: text.length,
    },
  });
  await emitTurnEventBestEffort(input, {
    kind: "turn.completed",
    payload: { safeLabel: "Completed" },
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
