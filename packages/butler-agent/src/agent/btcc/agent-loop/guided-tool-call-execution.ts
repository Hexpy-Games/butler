import type { BtccTurnProgressObserver } from "../contracts.ts";
import type {
  DurableWorkService,
  WorkTurnScope,
} from "../work/index.ts";
import type { TurnRecord } from "../turn/index.ts";
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
} from "./durable-work-tools.ts";
import { isDurableWorkTool } from "../work/index.ts";
import {
  backfillTurnToolResults,
  bindPresentedWorkForToolDispatch,
  publishWorkProgress,
  safeAttachToolResult,
  safeBindOpenWork,
} from "./guided-work-runtime.ts";
import {
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
} from "../projection/index.ts";
import { createGuidedToolResumePool } from "./guided-tool-resume-pool.ts";
import { guidedToolOccurrence } from "./guided-tool-occurrence.ts";
import { finishFailedTool } from "./guided-tool-failure.ts";

export type GuidedToolCallExecutionInput = {
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
    const currentCallIndex = callIndex++;
    const occurrence = guidedToolOccurrence({
      turnId: input.turn.turnId,
      callIndex: currentCallIndex,
      providerCallId: call.providerCallId,
      name: call.name,
      args: call.args,
    });
    const { callId: computedCallId, providerCallId } = occurrence;
    const exactRecord = input.toolJournal.find(computedCallId);
    let callId = computedCallId;
    if (exactRecord) {
      resumePool.discard(computedCallId);
    } else if (!providerCallId) {
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
        args: call.args,
        status: "started",
      });
      if (isDurableWorkTool(call.name) && toolResultSucceeded(recorded.result)) {
        await activityProjection.publishAccepted(activity);
        await publishWorkProgress(
          input.progress,
          input.turn.turnId,
          input.turn.revision,
          input.durableWork,
        );
      }
      await publishOperation(input.progress, {
        turnId: input.turn.turnId,
        activityId: activity.activityId,
        requestId: callId,
        toolName: effectiveToolName,
        args: call.args,
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
        args: call.args,
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
        args: call.args,
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
      args: call.args,
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
      if (isDurableWorkTool(call.name) && toolResultSucceeded(result)) {
        await activityProjection.publishAccepted(activity);
        await publishWorkProgress(
          input.progress,
          input.turn.turnId,
          input.turn.revision,
          input.durableWork,
        );
      }
      await publishOperation(input.progress, {
        turnId: input.turn.turnId,
        activityId: activity.activityId,
        requestId: callId,
        toolName: effectiveToolName,
        args: call.args,
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
        call.args,
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
    args: call.args,
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

function throwIfToolAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Guided tool execution was cancelled");
}
