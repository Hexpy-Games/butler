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
import { normalizeGuidedToolCall } from "../../tools/tool-support.ts";
import {
  effectiveToolNameForCall,
  invalidRunCommandSummary,
} from "./guided-turn-policy.ts";
import {
  isDurableWorkTool,
  isWorkRelationshipTool,
} from "../work/index.ts";
import {
  publishWorkProgress,
  safeAttachToolResult,
} from "./guided-work-runtime.ts";
import {
  publishOperation,
  rememberDescribedTools,
  safeJson,
  toolResultSucceeded,
} from "./guided-tool-progress.ts";
import {
  createGuidedActivityProjection,
  type GuidedActivityProjection,
} from "../projection/index.ts";
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
import { executeGuidedFreshTool } from "./guided-fresh-tool-execution.ts";
import { denyUnauthorizedTool } from "./guided-unauthorized-tool.ts";
import {
  priorTurnResultCallIds,
  replayRecordedGuidedToolCall,
} from "./guided-recorded-tool-replay.ts";

export type GuidedToolCallExecutionInput = {
  turn: TurnRecord;
  signal: AbortSignal;
  resolveModelRef?: () => string;
  progress?: BtccTurnProgressObserver;
  activity?: GuidedActivityProjection;
  workScope: WorkTurnScope;
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
    const replayed = await replayRecordedGuidedToolCall({
      execution: input,
      call,
      callId,
      effectiveToolName,
      presentationArgs,
      activityProjection,
      activity,
      record: recorded ?? undefined,
      executeFresh: (executionCall, priorToolCallIds) =>
        executeFreshTool(input, executionCall, callId, toolSignal, priorToolCallIds),
    });
    if (replayed) return replayed.result;

    if (!recorded) {
      input.toolJournal.start({
        turnId: input.turn.turnId,
        callId,
        toolName: effectiveToolName,
        rawArguments: call.rawArguments,
        arguments: presentationArgs,
      });
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
      const result = await executeFreshTool(
        input,
        call,
        callId,
        toolSignal,
        call.name === "replace_work_plan" || isWorkRelationshipTool(call.name)
          ? priorTurnResultCallIds(input)
          : undefined,
      );
      rememberDescribedTools(call.name, result, input.describedToolIds);
      input.toolJournal.finish({ callId, status: "completed", result });
      if (!isDurableWorkTool(call.name)) {
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
      return result;
    } catch (error) {
      return finishFailedTool(
        input,
        call.name,
        callId,
        effectiveToolName,
        presentationArgs,
        toolSignal,
        error,
        activity,
      );
    }
  };
  return { executeTool, usedTools };
}

async function executeFreshTool(
  input: GuidedToolCallExecutionInput,
  call: Parameters<ButlerToolExecutor>[0],
  callId: string,
  toolSignal: AbortSignal,
  priorToolCallIds?: readonly string[],
): Promise<unknown> {
  return executeGuidedFreshTool({
    durableWork: input.durableWork,
    workScope: input.workScope,
    call,
    callId,
    toolSignal,
    priorToolCallIds,
    executeButlerTool: input.executeButlerTool,
  });
}

function throwIfToolAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Guided tool execution was cancelled");
}
