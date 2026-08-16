import type { ButlerToolExecutor } from "../../tools/butler-tools.ts";
import type {
  GuidedToolJournal,
  GuidedToolJournalRecord,
} from "../ports/index.ts";
import type { BtccTurnProgressObserver } from "../contracts.ts";
import type {
  GuidedActivityBinding,
  GuidedActivityProjection,
} from "../projection/index.ts";
import type { DurableWorkService, WorkTurnScope } from "../work/index.ts";
import type { TurnRecord } from "../turn/index.ts";
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
  isReplaySafeTool,
  priorToolFailure,
  uncertainPriorMutation,
} from "./guided-turn-policy.ts";
type GuidedToolCall = Parameters<ButlerToolExecutor>[0];

/**
 * The replay domain only consumes this narrow execution port. Keeping it here
 * prevents the journal replayer from depending on the broad caller contract.
 */
export type GuidedRecordedToolReplayExecution = {
  turn: Pick<TurnRecord, "turnId" | "revision">;
  progress?: BtccTurnProgressObserver;
  workScope: WorkTurnScope;
  describedToolIds: Set<string>;
  durableWork: DurableWorkService;
  toolJournal: GuidedToolJournal;
  resolveModelRef?: () => string;
};

export type GuidedRecordedToolReplayInput = {
  execution: GuidedRecordedToolReplayExecution;
  call: GuidedToolCall;
  callId: string;
  effectiveToolName: string;
  presentationArgs: Record<string, unknown>;
  activityProjection: GuidedActivityProjection;
  activity: GuidedActivityBinding;
  record?: GuidedToolJournalRecord;
  executeFresh: (
    call: GuidedToolCall,
    priorToolCallIds?: readonly string[],
  ) => Promise<unknown>;
};

export type GuidedRecordedToolReplayResult = {
  handled: true;
  result: unknown;
};

export async function replayRecordedGuidedToolCall(
  input: GuidedRecordedToolReplayInput,
): Promise<GuidedRecordedToolReplayResult | null> {
  const record = input.record;
  if (!record) return null;
  if (record.status === "completed") {
    await repairCompletedWorkRelation(input, record);
    if (!isDurableWorkTool(input.call.name)) {
      await safeAttachToolResult(input.execution, input.execution.workScope, record.callId);
    }
    rememberDescribedTools(
      input.call.name,
      record.result,
      input.execution.describedToolIds,
    );
    await publishOperation(input.execution.progress, {
      turnId: input.execution.turn.turnId,
      activityId: input.activity.activityId,
      requestId: input.callId,
      toolName: input.effectiveToolName,
      args: input.presentationArgs,
      status: "started",
    });
    if (isDurableWorkTool(input.call.name) && toolResultSucceeded(record.result)) {
      await input.activityProjection.publishAccepted(input.activity);
      await publishWorkProgress(
        input.execution.progress,
        input.execution.turn.turnId,
        input.execution.turn.revision,
        input.execution.durableWork,
        input.execution.resolveModelRef?.(),
      );
    }
    await publishOperation(input.execution.progress, {
      turnId: input.execution.turn.turnId,
      activityId: input.activity.activityId,
      requestId: input.callId,
      toolName: input.effectiveToolName,
      args: input.presentationArgs,
      status: toolResultSucceeded(record.result) ? "completed" : "failed",
      resultJson: safeJson(record.result),
    });
    return { handled: true, result: record.result };
  }
  if (record.status === "failed" || record.status === "cancelled") {
    await publishOperation(input.execution.progress, {
      turnId: input.execution.turn.turnId,
      activityId: input.activity.activityId,
      requestId: input.callId,
      toolName: input.effectiveToolName,
      args: input.presentationArgs,
      status: record.status === "cancelled" ? "cancelled" : "failed",
    });
    return {
      handled: true,
      result: priorToolFailure(record.status, input.effectiveToolName),
    };
  }
  if (record.status === "started" && !isReplaySafeTool(input.effectiveToolName)) {
    await publishOperation(input.execution.progress, {
      turnId: input.execution.turn.turnId,
      activityId: input.activity.activityId,
      requestId: input.callId,
      toolName: input.effectiveToolName,
      args: input.presentationArgs,
      status: "failed",
    });
    return {
      handled: true,
      result: uncertainPriorMutation(input.effectiveToolName),
    };
  }
  return null;
}

async function repairCompletedWorkRelation(
  input: GuidedRecordedToolReplayInput,
  record: GuidedToolJournalRecord,
): Promise<void> {
  if (!isDurableWorkTool(input.call.name) || !toolResultSucceeded(record.result)) return;
  if (input.call.name !== "replace_work_plan" && !isWorkRelationshipTool(input.call.name)) return;
  const repaired = await input.executeFresh(
    input.call,
    priorTurnResultCallIds(input.execution),
  );
  if (!toolResultSucceeded(repaired)) {
    throw new Error("Durable Work relation replay could not repair prior results");
  }
}

export function priorTurnResultCallIds(
  input: Pick<GuidedRecordedToolReplayExecution, "turn" | "toolJournal">,
): string[] {
  return input.toolJournal.list(input.turn.turnId)
    .filter((record) => record.status === "completed" && !isDurableWorkTool(record.toolName))
    .map((record) => record.callId);
}
