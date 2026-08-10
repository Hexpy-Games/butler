import type {
  ButlerToolExecutor,
  ContextualButlerToolExecutor,
} from "../../tools/butler-tools.ts";
import type { SqliteGuidedToolJournal } from "../../adapters/index.ts";
import type {
  DurableWorkService,
  WorkTurnScope,
} from "../work/index.ts";
import { isDurableWorkTool } from "../work/index.ts";
import { executeDurableWorkTool } from "./durable-work-tools.ts";
import {
  backfillTurnToolResults,
  safeBindOpenWork,
} from "./guided-work-runtime.ts";
import type { GuidedCompactReplayRuntime } from
  "./guided-compact-replay-runtime.ts";
import { executeCompactReplayControlTool } from
  "./guided-compact-replay-control.ts";
import type { GuidedToolCallExecutionInput } from
  "./guided-tool-call-contracts.ts";
import { rejectUnrecoveredCompactReplayWorkReview } from
  "./compact-replay-correction-recovery.ts";

type GuidedToolCall = Parameters<ButlerToolExecutor>[0];

export function executeGuidedFreshToolForCall(
  input: GuidedToolCallExecutionInput,
  call: GuidedToolCall,
  callId: string,
  toolSignal: AbortSignal,
): Promise<unknown> {
  return executeGuidedFreshTool({
    durableWork: input.durableWork,
    toolJournal: input.toolJournal,
    workScope: input.workScope,
    call,
    callId,
    toolSignal,
    executeButlerTool: input.executeButlerTool,
    compactReplayRuntime: input.compactReplayRuntime,
  });
}

export async function executeGuidedFreshTool(input: {
  durableWork: DurableWorkService;
  toolJournal: SqliteGuidedToolJournal;
  workScope: WorkTurnScope;
  call: GuidedToolCall;
  callId: string;
  toolSignal: AbortSignal;
  executeButlerTool: ContextualButlerToolExecutor;
  compactReplayRuntime: GuidedCompactReplayRuntime;
}): Promise<unknown> {
  const compactControl = await executeCompactReplayControlTool({
    name: input.call.name,
    args: input.call.args,
    durableWork: input.durableWork,
    toolJournal: input.toolJournal,
    workScope: input.workScope,
    runtime: input.compactReplayRuntime,
  });
  if (compactControl.handled) return compactControl.result;
  let boundWork = null;
  if (isDurableWorkTool(input.call.name) && input.call.name !== "replace_work_plan") {
    await safeBindOpenWork(input.durableWork, input.workScope);
    await backfillTurnToolResults(
      { durableWork: input.durableWork, toolJournal: input.toolJournal },
      input.workScope,
    );
    boundWork = await safeBindOpenWork(input.durableWork, input.workScope);
  }
  if (isDurableWorkTool(input.call.name)) {
    if (input.compactReplayRuntime.enabled &&
      input.call.name === "record_work_review" && boundWork) {
      const rejection = rejectUnrecoveredCompactReplayWorkReview({
        work: boundWork,
        toolJournal: input.toolJournal,
        turnId: input.workScope.turnId,
        args: input.call.args,
      });
      if (rejection) return rejection;
    }
    return executeDurableWorkTool({
      service: input.durableWork,
      scope: input.workScope,
      mutationCallId: input.callId,
      name: input.call.name,
      args: input.call.args,
    });
  }
  return input.executeButlerTool({
    ...input.call,
    signal: input.toolSignal,
  }, { effectOccurrenceId: input.callId });
}
