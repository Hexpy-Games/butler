import type { ButlerToolExecutor } from "../../tools/butler-tools.ts";
import { normalizeGuidedToolCall } from "../../tools/tool-support.ts";
import {
  effectiveToolNameForCall,
  invalidRunCommandSummary,
  isReplaySafeTool,
  priorToolFailure,
  uncertainPriorMutation,
} from "./guided-turn-policy.ts";
import { isDurableWorkTool } from "../work/index.ts";
import {
  backfillTurnToolResults,
  bindPresentedWorkForToolDispatch,
  publishWorkProgress,
  safeAttachToolResult,
} from "./guided-work-runtime.ts";
import {
  publishOperation,
  rememberDescribedTools,
  safeJson,
  toolResultSucceeded,
} from "./guided-tool-progress.ts";
import { createGuidedActivityProjection } from "../projection/index.ts";
import { createGuidedToolResumePool } from "./guided-tool-resume-pool.ts";
import {
  guidedToolCatalogId,
  guidedToolOccurrence,
} from "./guided-tool-occurrence.ts";
import { finishFailedTool } from "./guided-tool-failure.ts";
import {
  findLegacyToolRecord,
  replaySummarylessLegacyCall,
} from "./guided-legacy-tool-replay.ts";
import { executeGuidedFreshToolForCall as executeFreshTool } from
  "./guided-fresh-tool-execution.ts";
import { denyUnauthorizedTool } from "./guided-unauthorized-tool.ts";
import { isM1CompactReplayControlTool } from
  "../../tools/m1-compact-replay.ts";
import {
  envelopeGuidedCompactReplayResult as compactReplayEnvelope,
  journalGuidedCompactReplayResult as journalResult,
  rehydrateGuidedCompactReplayResult as completedReplayResult,
} from "./guided-compact-replay-execution.ts";
import type { GuidedToolCallExecutionInput } from
  "./guided-tool-call-contracts.ts";
import { throwIfExecutionWindowAborted } from "./execution-window.ts";
import {
  TurnContinuationBudgetExhaustedError,
  TurnContinuationBudgetStorageError,
} from "../turn/continuation-budget.ts";

export type { GuidedToolCallExecutionInput } from
  "./guided-tool-call-contracts.ts";

export function createGuidedToolCallExecutor(
  input: GuidedToolCallExecutionInput,
): {
  executeTool: ButlerToolExecutor;
  usedTools: string[];
} {
  let callIndex = 0;
  const usedTools: string[] = [];
  const activityProjection = input.activity ?? createGuidedActivityProjection({
    turnId: input.turn.turnId,
    progress: input.progress,
  });
  const resumePool = createGuidedToolResumePool(
    input.toolJournal.list(input.turn.turnId),
  );
  const executeTool: ButlerToolExecutor = async (call) => {
    const toolSignal = call.signal ?? input.signal;
    throwIfExecutionWindowAborted(toolSignal);
    const effectiveToolName = effectiveToolNameForCall(call.name, call.args);
    const normalizedCall = normalizeGuidedToolCall({
      toolName: effectiveToolName,
      args: call.args,
    });
    const presentationArgs = normalizedCall.args;
    const currentCallIndex = callIndex++;
    const occurrence = guidedToolOccurrence({
      turnId: input.turn.turnId,
      callIndex: currentCallIndex,
      providerCallId: call.providerCallId,
      name: call.name,
      args: call.args,
    });
    const {
      callId: computedCallId,
      legacyProviderCallIds,
      providerCallId,
    } = occurrence;
    const exactRecord = input.toolJournal.find(computedCallId);
    const legacyRecord = !exactRecord
      ? findLegacyToolRecord(input.toolJournal, legacyProviderCallIds)
      : undefined;
    const existingRecord = exactRecord ?? legacyRecord;
    let callId = existingRecord?.callId ?? computedCallId;
    if (exactRecord) {
      resumePool.discard(computedCallId);
    } else if (legacyRecord) {
      resumePool.discard(legacyRecord.callId);
    } else if (!providerCallId) {
      callId = resumePool.claim(
        effectiveToolName,
        presentationArgs,
        guidedToolCatalogId(call.name, call.args),
      ) ?? computedCallId;
    }
    usedTools.push(effectiveToolName);
    const invalidSummary = invalidRunCommandSummary({
      callName: call.name,
      callArgs: call.args,
      effectiveToolName,
      presentationArgs,
    });
    const legacyReplay = await replaySummarylessLegacyCall({
      record: legacyRecord,
      callName: call.name,
      callArgs: call.args,
      visible: input.visibleNames.has(call.name),
      authorized: input.authorizedNames.has(call.name),
      call,
      callId,
      effectiveToolName,
      signal: toolSignal,
      runtime: {
        durableWork: input.durableWork,
        toolJournal: input.toolJournal,
      },
      scope: input.workScope,
      executeFresh: (executionCall) =>
        executeFreshTool(input, executionCall, callId, toolSignal),
    });
    if (legacyReplay) {
      rememberDescribedTools(call.name, legacyReplay.result, input.describedToolIds);
      return legacyReplay.result;
    }
    if (
      invalidSummary &&
      input.visibleNames.has(call.name) &&
      input.authorizedNames.has(call.name)
    ) {
      return invalidSummary;
    }
    const activity = await activityProjection.observeTool({
      name: effectiveToolName,
      effectiveToolName,
      args: presentationArgs,
    });

    if (
      !input.visibleNames.has(call.name) ||
      !input.authorizedNames.has(call.name)
    ) {
      return denyUnauthorizedTool(
        input,
        callId,
        effectiveToolName,
        call,
        presentationArgs,
        activity,
      );
    }

    const recorded = input.toolJournal.find(callId);
    if (recorded?.status === "completed") {
      const completedResult = await completedReplayResult(
        input,
        call.name,
        recorded,
      );
      if (!isDurableWorkTool(call.name) &&
        !isM1CompactReplayControlTool(call.name)) {
        await safeAttachToolResult(input, input.workScope, recorded.callId);
      }
      rememberDescribedTools(
        call.name,
        completedResult,
        input.describedToolIds,
      );
      await publishOperation(input.progress, {
        turnId: input.turn.turnId,
        activityId: activity.activityId,
        requestId: callId,
        toolName: effectiveToolName,
        args: presentationArgs,
        status: "started",
      });
      if (isDurableWorkTool(call.name) && toolResultSucceeded(recorded.result)) {
        await activityProjection.publishAccepted(activity);
        await publishWorkProgress(
          input.progress,
          input.turn.turnId,
          input.turn.revision,
          input.durableWork,
          input.resolveModelRef?.(),
        );
      }
      await publishOperation(input.progress, {
        turnId: input.turn.turnId,
        activityId: activity.activityId,
        requestId: callId,
        toolName: effectiveToolName,
        args: presentationArgs,
        status: toolResultSucceeded(recorded.result) ? "completed" : "failed",
        resultJson: safeJson(completedResult),
      });
      return compactReplayEnvelope(
        input,
        call.name,
        recorded.callId,
        completedResult,
        true,
      );
    }
    if (recorded?.status === "failed" || recorded?.status === "cancelled") {
      await publishOperation(input.progress, {
        turnId: input.turn.turnId,
        activityId: activity.activityId,
        requestId: callId,
        toolName: effectiveToolName,
        args: presentationArgs,
        status: recorded.status === "cancelled" ? "cancelled" : "failed",
      });
      return compactReplayEnvelope(
        input,
        call.name,
        recorded.callId,
        priorToolFailure(recorded.status, effectiveToolName),
        true,
      );
    }
    if (recorded?.status === "started" && !isReplaySafeTool(effectiveToolName)) {
      await publishOperation(input.progress, {
        turnId: input.turn.turnId,
        activityId: activity.activityId,
        requestId: callId,
        toolName: effectiveToolName,
        args: presentationArgs,
        status: "failed",
      });
      return uncertainPriorMutation(effectiveToolName);
    }

    if (!recorded) {
      input.toolJournal.start({
        turnId: input.turn.turnId,
        callId,
        toolName: effectiveToolName,
        rawArguments: call.rawArguments,
        arguments: presentationArgs,
        operationBatchId: call.operationBatchId,
        operationBatchOrdinal: call.operationBatchOrdinal,
        continuationBudgetClaim: input.continuationBudget?.claim,
      });
    }
    if (
      !isDurableWorkTool(call.name) && input.presentedWorkId &&
      await bindPresentedWorkForToolDispatch(
        input,
        input.workScope,
        input.presentedWorkId,
      )
    ) {
      await activityProjection.markManaged(activity);
    }
    await publishOperation(input.progress, {
      turnId: input.turn.turnId,
      activityId: activity.activityId,
      requestId: callId,
      toolName: effectiveToolName,
      args: presentationArgs,
      status: "started",
    });

    try {
      const result = await executeFreshTool(input, call, callId, toolSignal);
      rememberDescribedTools(call.name, result, input.describedToolIds);
      input.toolJournal.finish({
        callId,
        status: "completed",
        result: journalResult(call.name, result),
        continuationBudgetClaim: input.continuationBudget?.claim,
      });
      if (call.name === "replace_work_plan" && toolResultSucceeded(result)) {
        await backfillTurnToolResults(input, input.workScope);
      } else if (!isDurableWorkTool(call.name) &&
        !isM1CompactReplayControlTool(call.name)) {
        await safeAttachToolResult(input, input.workScope, callId);
      }
      if (isDurableWorkTool(call.name) && toolResultSucceeded(result)) {
        await activityProjection.publishAccepted(activity);
        await publishWorkProgress(
          input.progress,
          input.turn.turnId,
          input.turn.revision,
          input.durableWork,
          input.resolveModelRef?.(),
        );
      }
      await publishOperation(input.progress, {
        turnId: input.turn.turnId,
        activityId: activity.activityId,
        requestId: callId,
        toolName: effectiveToolName,
        args: presentationArgs,
        status: toolResultSucceeded(result) ? "completed" : "failed",
        resultJson: safeJson(result),
      });
      return compactReplayEnvelope(
        input,
        call.name,
        callId,
        result,
        false,
      );
    } catch (error) {
      if (error instanceof TurnContinuationBudgetExhaustedError ||
          error instanceof TurnContinuationBudgetStorageError) throw error;
      const failure = await finishFailedTool(
        input,
        call.name,
        callId,
        effectiveToolName,
        presentationArgs,
        toolSignal,
        error,
        activity,
      );
      return compactReplayEnvelope(
        input,
        call.name,
        callId,
        failure,
        false,
      );
    }
  };
  return { executeTool, usedTools };
}
