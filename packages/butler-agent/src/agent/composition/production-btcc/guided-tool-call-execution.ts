import type { BtccTurnProgressObserver } from "../../btcc/index.ts";
import { digest, stableJson } from "../../btcc/identity/index.ts";
import type {
  DurableWorkService,
  WorkTurnScope,
} from "../../btcc/durable-work/index.ts";
import type { TurnRecord } from "../../btcc/turn/index.ts";
import type {
  SqliteGuidedToolJournal,
} from "../../adapters/index.ts";
import type {
  ButlerToolExecutor,
  ContextualButlerToolExecutor,
} from "../../tools/butler-tools.ts";
import {
  effectiveToolNameForCall,
  isReplaySafeTool,
  priorToolFailure,
  uncertainPriorMutation,
} from "./guided-turn-policy.ts";
import {
  executeDurableWorkTool,
  isDurableWorkTool,
} from "./durable-work-tools.ts";
import {
  backfillTurnToolResults,
  bindPresentedWorkForToolDispatch,
  publishWorkCheckpoint,
  safeAttachToolResult,
  safeBindOpenWork,
} from "./guided-work-runtime.ts";
import {
  ordinaryToolError,
  publishOperation,
  rememberDescribedTools,
  safeJson,
  toolResultSucceeded,
  unauthorizedToolResult,
} from "./guided-tool-progress.ts";
import {
  createGuidedActivityProjection,
  type GuidedActivityBinding,
  type GuidedActivityProjection,
} from "./guided-activity-projection.ts";
import { createGuidedToolResumePool } from "./guided-tool-resume-pool.ts";

type GuidedToolCallExecutionInput = {
  turn: TurnRecord;
  signal: AbortSignal;
  progress?: BtccTurnProgressObserver;
  activity?: GuidedActivityProjection;
  workScope: WorkTurnScope;
  presentedWorkId?: string;
  authorizedNames: ReadonlySet<string>;
  visibleNames: ReadonlySet<string>;
  describedToolIds: Set<string>;
  durableWork: DurableWorkService;
  toolJournal: SqliteGuidedToolJournal;
  executeButlerTool: ContextualButlerToolExecutor;
};

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
    throwIfToolAborted(toolSignal);
    const effectiveToolName = effectiveToolNameForCall(call.name, call.args);
    const computedCallId = digest([
      "btcc-guided-tool-call.v1",
      input.turn.turnId,
      String(callIndex++),
      call.name,
      stableJson(call.args),
    ].join("\0"));
    const exactRecord = input.toolJournal.find(computedCallId);
    let callId = computedCallId;
    if (exactRecord) {
      resumePool.discard(computedCallId);
    } else {
      callId = resumePool.claim(
        effectiveToolName,
        call.args,
      ) ?? computedCallId;
    }
    usedTools.push(effectiveToolName);
    const activity = await activityProjection.observeTool({
      name: call.name,
      effectiveToolName,
      args: call.args,
    });

    if (
      !input.visibleNames.has(call.name) ||
      !input.authorizedNames.has(call.name)
    ) {
      return denyUnauthorizedTool(input, callId, effectiveToolName, call, activity);
    }

    const recorded = input.toolJournal.find(callId);
    if (recorded?.status === "completed") {
      if (!isDurableWorkTool(call.name)) {
        await safeAttachToolResult(input, input.workScope, recorded.callId);
      }
      rememberDescribedTools(
        call.name,
        recorded.result,
        input.describedToolIds,
      );
      await publishOperation(input.progress, {
        turnId: input.turn.turnId,
        activityId: activity.activityId,
        requestId: callId,
        toolName: effectiveToolName,
        status: "started",
      });
      if (
        call.name === "record_work_checkpoint" &&
        toolResultSucceeded(recorded.result)
      ) {
        await publishWorkCheckpoint(
          input.progress,
          input.turn.turnId,
          input.durableWork,
          activity.activityId,
        );
      }
      await publishOperation(input.progress, {
        turnId: input.turn.turnId,
        activityId: activity.activityId,
        requestId: callId,
        toolName: effectiveToolName,
        status: toolResultSucceeded(recorded.result) ? "completed" : "failed",
        resultJson: safeJson(recorded.result),
      });
      return recorded.result;
    }
    if (recorded?.status === "failed" || recorded?.status === "cancelled") {
      await publishOperation(input.progress, {
        turnId: input.turn.turnId,
        activityId: activity.activityId,
        requestId: callId,
        toolName: effectiveToolName,
        status: recorded.status === "cancelled" ? "cancelled" : "failed",
      });
      return priorToolFailure(recorded.status, effectiveToolName);
    }
    if (recorded?.status === "started" && !isReplaySafeTool(effectiveToolName)) {
      await publishOperation(input.progress, {
        turnId: input.turn.turnId,
        activityId: activity.activityId,
        requestId: callId,
        toolName: effectiveToolName,
        status: "failed",
      });
      return uncertainPriorMutation(effectiveToolName);
    }

    input.toolJournal.start({
      turnId: input.turn.turnId,
      callId,
      toolName: effectiveToolName,
      rawArguments: call.rawArguments,
      arguments: call.args,
    });
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
      status: "started",
    });

    try {
      const result = await executeFreshTool(input, call, callId, toolSignal);
      rememberDescribedTools(call.name, result, input.describedToolIds);
      input.toolJournal.finish({ callId, status: "completed", result });
      if (call.name === "replace_work_plan" && toolResultSucceeded(result)) {
        await backfillTurnToolResults(input, input.workScope);
      } else if (!isDurableWorkTool(call.name)) {
        await safeAttachToolResult(input, input.workScope, callId);
      }
      if (
        call.name === "record_work_checkpoint" &&
        toolResultSucceeded(result)
      ) {
        await publishWorkCheckpoint(
          input.progress,
          input.turn.turnId,
          input.durableWork,
          activity.activityId,
        );
      }
      await publishOperation(input.progress, {
        turnId: input.turn.turnId,
        activityId: activity.activityId,
        requestId: callId,
        toolName: effectiveToolName,
        status: toolResultSucceeded(result) ? "completed" : "failed",
        resultJson: safeJson(result),
      });
      return result;
    } catch (error) {
      return finishFailedTool(
        input,
        call.name,
        callId,
        effectiveToolName,
        toolSignal,
        error,
        activity,
      );
    }
  };
  return { executeTool, usedTools };
}

async function denyUnauthorizedTool(
  input: GuidedToolCallExecutionInput,
  callId: string,
  effectiveToolName: string,
  call: Parameters<ButlerToolExecutor>[0],
  activity: GuidedActivityBinding,
): Promise<unknown> {
  const denied = unauthorizedToolResult(effectiveToolName);
  const recorded = input.toolJournal.find(callId);
  if (!recorded) {
    input.toolJournal.start({
      turnId: input.turn.turnId,
      callId,
      toolName: effectiveToolName,
      rawArguments: call.rawArguments,
      arguments: call.args,
    });
    input.toolJournal.finish({ callId, status: "completed", result: denied });
  }
  const result = recorded?.result ?? denied;
  await publishOperation(input.progress, {
    turnId: input.turn.turnId,
    activityId: activity.activityId,
    requestId: callId,
    toolName: effectiveToolName,
    status: "failed",
    resultJson: safeJson(result),
  });
  return result;
}

async function executeFreshTool(
  input: GuidedToolCallExecutionInput,
  call: Parameters<ButlerToolExecutor>[0],
  callId: string,
  toolSignal: AbortSignal,
): Promise<unknown> {
  if (isDurableWorkTool(call.name) && call.name !== "replace_work_plan") {
    await safeBindOpenWork(input.durableWork, input.workScope);
    await backfillTurnToolResults(input, input.workScope);
  }
  if (isDurableWorkTool(call.name)) {
    return executeDurableWorkTool({
      service: input.durableWork,
      scope: input.workScope,
      mutationCallId: callId,
      name: call.name,
      args: call.args,
    });
  }
  return input.executeButlerTool({
    ...call,
    signal: toolSignal,
  }, { effectOccurrenceId: callId });
}

async function finishFailedTool(
  input: GuidedToolCallExecutionInput,
  toolName: string,
  callId: string,
  effectiveToolName: string,
  toolSignal: AbortSignal,
  error: unknown,
  activity: GuidedActivityBinding,
): Promise<unknown> {
  const cancelled = input.signal.aborted || toolSignal.aborted;
  if (!cancelled) {
    const result = ordinaryToolError(effectiveToolName, error);
    input.toolJournal.finish({ callId, status: "completed", result });
    if (!isDurableWorkTool(toolName)) {
      await safeAttachToolResult(input, input.workScope, callId);
    }
    await publishOperation(input.progress, {
      turnId: input.turn.turnId,
      activityId: activity.activityId,
      requestId: callId,
      toolName: effectiveToolName,
      status: "failed",
      resultJson: safeJson(result),
    });
    return result;
  }
  input.toolJournal.finish({
    callId,
    status: "cancelled",
    errorCode: "cancelled",
  });
  await publishOperation(input.progress, {
    turnId: input.turn.turnId,
    activityId: activity.activityId,
    requestId: callId,
    toolName: effectiveToolName,
    status: "cancelled",
  });
  throw error;
}

function throwIfToolAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Guided tool execution was cancelled");
}
