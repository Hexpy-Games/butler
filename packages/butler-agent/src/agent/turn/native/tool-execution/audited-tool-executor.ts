import { randomUUID } from "crypto";
import type { FunctionToolPromptOptions } from "../../../../integrations/providers/provider.ts";
import {
  appendTranscriptEvent,
  createTranscriptEvent,
} from "../../../../test-support/harness/transcripts.ts";
import { createAuditedBridgeToolExecutor } from "../../bridge-tool-executor.ts";
import { RepeatedToolFamilyGuard } from "../../tool-loop-guards.ts";
import { createProjectLedgerFreshnessCache } from "./project-ledger-freshness-cache.ts";
import { applyPlannedReviewToolPolicy } from "../policy/planned-review-tool-policy.ts";
import {
  isInternalProgressTool,
  shouldSynthesizeRuntimeSemanticProgress,
  WORKER_ORCHESTRATION_START_TOOL_SET,
} from "../progress/runtime-semantic-progress.ts";
import { createInternalProgressToolRunner } from "./internal-progress-tool.ts";
import { maybeHandleRepeatedToolFamily } from "./repeated-tool-guard-result.ts";
import { handleAuditedToolFailure } from "./tool-call-failure.ts";
import { handleAuditedToolSuccess } from "./tool-call-success.ts";
import {
  buildIntermediateAction,
  emitIntermediateBestEffort,
  emitTurnEventBestEffort,
} from "../progress/turn-delivery-events.ts";
import {
  appendPublicDecisionTranscript,
  emitStartedProgress,
  taskSummaryForTool,
} from "./tool-call-start.ts";
import { summarizeToolProgress } from "../../../output/progress/tool-progress.ts";
import {
  evidenceTranscriptErrorMessage,
} from "../../../output/evidence/transcript-result.ts";
import {
  hasCompleteAuthoredPublicDecisionForTool,
  takePublicWorkDecisionForTool,
} from "../../../output/public-work/decisions.ts";
import {
  publicDecisionRequiredObservation,
  throwIfToolResultNeedsObservation,
  toolObservationResult,
} from "./tool-observations.ts";
import type {
  NativeAuditedToolExecutorInput,
  NativeToolCall,
} from "./audited-executor-types.ts";

export function createAuditedButlerToolExecutor(
  input: NativeAuditedToolExecutorInput,
): FunctionToolPromptOptions["executeTool"] {
  const projectLedgerFreshnessCache = createProjectLedgerFreshnessCache(input.executor);
  const repeatedToolFamilyGuard = new RepeatedToolFamilyGuard();
  const internalProgress = createInternalProgressToolRunner({
    executorInput: input,
    throwIfAborted: () => throwIfRuntimeTurnAborted(input.turnInput.signal),
    discardPendingPublicDecisionForTool: (toolName) =>
      discardPendingPublicDecisionForTool(input.pendingPublicDecisions, toolName),
  });
  const executeAuditedTarget = async (
    call: NativeToolCall,
    bridgedFrom?: Parameters<typeof createAuditedBridgeToolExecutor>[0]["executeTarget"] extends (
      call: NativeToolCall,
      bridgedFrom?: infer T,
    ) => unknown ? T : never,
  ): Promise<unknown> => {
    const startedAt = Date.now();
    const cleanArgs = { ...call.args };
    const inboundEnvelope = "eventId" in input.turnInput.input ? input.turnInput.input : null;
    if (isInternalProgressTool(call.name)) {
      return await internalProgress.run(call, "model");
    }
    const plannedReviewBlock = applyPlannedReviewToolPolicy({
      plannedReview: input.plannedReview,
      toolName: call.name,
      args: cleanArgs,
    });
    if (plannedReviewBlock) {
      appendPlannedReviewBlock(input, call, cleanArgs, plannedReviewBlock);
      return plannedReviewBlock.result;
    }
    const repeatedToolFamilyResult = maybeHandleRepeatedToolFamily({
      executorInput: input,
      guard: repeatedToolFamilyGuard,
      call,
      cleanArgs,
      startedAt,
    });
    if (repeatedToolFamilyResult) return repeatedToolFamilyResult;

    if (input.assistantTextBeforeToolsSeen() && !hasCompleteAuthoredPublicDecisionForTool({
      pending: input.pendingPublicDecisions,
      toolName: call.name,
    })) {
      const observation = publicDecisionRequiredObservation({
        turnId: input.turnId,
        call,
      });
      appendTranscriptEvent(createTranscriptEvent({
        sessionId: input.sessionId,
        kind: "tool_result",
        payload: {
          name: call.name,
          ok: false,
          observation,
        },
        metadata: {
          source: "runtime/native-tool-loop.ts#public-decision-gate",
        },
      }));
      return toolObservationResult(observation);
    }

    const state = await prepareAuditedToolExecution({
      input,
      call,
      cleanArgs,
      internalProgress,
    });
    try {
      throwIfRuntimeTurnAborted(input.turnInput.signal);
      const result = await projectLedgerFreshnessCache.execute({ ...call, args: cleanArgs });
      if (call.name === "tool_describe") {
        input.toolSurfaceController?.recordToolDescriptionResult(result);
      }
      throwIfToolResultNeedsObservation({ call, result });
      throwIfRuntimeTurnAborted(input.turnInput.signal);
      repeatedToolFamilyGuard.resetAfterStateMutation(call.name, cleanArgs);
      return await handleAuditedToolSuccess({
        executorInput: input,
        call,
        cleanArgs,
        bridgedFrom,
        result,
        startedAt,
        ...state,
        inboundEnvelope,
        updateRuntimeSemanticProgress: async (update) => {
          await internalProgress.runtimeUpdate(update);
        },
      });
    } catch (error) {
      projectLedgerFreshnessCache.invalidateAfterTool({ ...call, args: cleanArgs });
      return await handleAuditedToolFailure({
        executorInput: input,
        call,
        cleanArgs,
        bridgedFrom,
        error,
        startedAt,
        ...state,
      });
    }
  };
  const executeAuditedWithBridge = createAuditedBridgeToolExecutor({
    sessionId: input.sessionId,
    audit: input.audit,
    turnInput: input.turnInput,
    messageLanguage: input.messageLanguage,
    executor: input.executor,
    buildIntermediateAction,
    emitIntermediateBestEffort,
    emitTurnEventBestEffort,
    throwIfAborted: () => throwIfRuntimeTurnAborted(input.turnInput.signal),
    executeTarget: executeAuditedTarget,
  });
  return async (call) => await executeAuditedWithBridge(call);
}

function throwIfRuntimeTurnAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Runtime turn was cancelled.");
  error.name = "AbortError";
  throw error;
}

function discardPendingPublicDecisionForTool(
  pending: NativeAuditedToolExecutorInput["pendingPublicDecisions"],
  toolName: string,
): void {
  const index = pending.findIndex((decision) => decision.toolName === toolName);
  if (index >= 0) pending.splice(index, 1);
}

function appendPlannedReviewBlock(
  input: NativeAuditedToolExecutorInput,
  call: NativeToolCall,
  cleanArgs: Record<string, unknown>,
  plannedReviewBlock: {
    error: string;
    reviewTaskId: string;
    result: unknown;
  },
): void {
  input.audit.push({
    name: call.name,
    args: cleanArgs,
    ok: false,
    error: plannedReviewBlock.error,
  });
  appendTranscriptEvent(createTranscriptEvent({
    sessionId: input.sessionId,
    kind: "tool_result",
    payload: {
      name: call.name,
      ok: false,
      error: evidenceTranscriptErrorMessage(plannedReviewBlock.error),
      planned_review_task_id: plannedReviewBlock.reviewTaskId,
    },
    metadata: {
      source: "runtime/native-tool-loop.ts#planned-review-policy",
    },
  }));
}

async function prepareAuditedToolExecution(input: {
  input: NativeAuditedToolExecutorInput;
  call: NativeToolCall;
  cleanArgs: Record<string, unknown>;
  internalProgress: ReturnType<typeof createInternalProgressToolRunner>;
}): Promise<{
  toolCallId: string;
  workBlockId: string;
  workBlockLabel: string;
  progress: ReturnType<typeof summarizeToolProgress>;
  decision: ReturnType<typeof takePublicWorkDecisionForTool>;
  usesSemanticWorkBlock: boolean;
  semanticProgressEstablished: boolean;
  isWorkerStartTool: boolean;
  taskSummary: string;
}> {
  const isWorkerStartTool = WORKER_ORCHESTRATION_START_TOOL_SET.has(input.call.name);
  const progress = summarizeToolProgress(
    input.call.name,
    input.cleanArgs,
    input.input.messageLanguage,
  );
  const decision = takePublicWorkDecisionForTool({
    pending: input.input.pendingPublicDecisions,
    toolName: input.call.name,
    progress,
    language: input.input.messageLanguage,
    previousDecisions: input.input.publicDecisionContext,
  });
  await maybeEmitRuntimeProgress(input, decision, progress, isWorkerStartTool);

  const toolCallId = `tool-${randomUUID().slice(0, 8)}`;
  const semanticWorkBlock = input.internalProgress.semanticProgressEstablished()
    ? input.internalProgress.currentSemanticWorkBlock()
    : null;
  const workBlockId = semanticWorkBlock?.id ?? `work-${toolCallId}`;
  decision.workBlockId = workBlockId;
  decision.toolName = input.call.name;
  const workBlockLabel = semanticWorkBlock?.label ?? decision.summary;
  input.input.publicDecisionContext.push(decision);
  appendPublicDecisionTranscript(input.input, decision);
  await emitStartedProgress({
    ...input,
    decision,
    progress,
    toolCallId,
    workBlockId,
    workBlockLabel,
    isWorkerStartTool,
    semanticProgressEstablished: input.internalProgress.semanticProgressEstablished(),
  });

  return {
    toolCallId,
    workBlockId,
    workBlockLabel,
    progress,
    decision,
    usesSemanticWorkBlock: Boolean(semanticWorkBlock),
    semanticProgressEstablished: input.internalProgress.semanticProgressEstablished(),
    isWorkerStartTool,
    taskSummary: taskSummaryForTool(input.call.name, input.cleanArgs),
  };
}

async function maybeEmitRuntimeProgress(
  input: {
    input: NativeAuditedToolExecutorInput;
    call: NativeToolCall;
    cleanArgs: Record<string, unknown>;
    internalProgress: ReturnType<typeof createInternalProgressToolRunner>;
  },
  decision: ReturnType<typeof takePublicWorkDecisionForTool>,
  progress: ReturnType<typeof summarizeToolProgress>,
  isWorkerStartTool: boolean,
): Promise<void> {
  const shouldForceRuntimeProgress =
    input.input.semanticProgressSafetyNet.source === "runtime" && !isWorkerStartTool;
  const shouldSynthesizeProgress =
    !input.internalProgress.semanticProgressEstablished() &&
    shouldSynthesizeRuntimeSemanticProgress({
      callName: input.call.name,
      args: input.cleanArgs,
    });
  if (!shouldForceRuntimeProgress && !shouldSynthesizeProgress) return;
  await input.internalProgress.runtimeUpdate({ decision, progress, state: "execution" });
}
