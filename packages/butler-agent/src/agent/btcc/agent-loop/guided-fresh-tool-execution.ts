import type {
  ButlerToolExecutor,
  ContextualButlerToolExecutor,
} from "../../tools/butler-tools.ts";
import type { GuidedToolJournal } from "../ports/index.ts";
import type {
  DurableWorkService,
  WorkTurnScope,
} from "../work/index.ts";
import { isDurableWorkTool, isWorkRelationshipTool } from "../work/index.ts";
import { executeDurableWorkTool } from "./durable-work-tools.ts";
import {
  backfillTurnToolResults,
  safeBindOpenWork,
} from "./guided-work-runtime.ts";

type GuidedToolCall = Parameters<ButlerToolExecutor>[0];

export async function executeGuidedFreshTool(input: {
  durableWork: DurableWorkService;
  toolJournal: GuidedToolJournal;
  workScope: WorkTurnScope;
  call: GuidedToolCall;
  callId: string;
  toolSignal: AbortSignal;
  priorToolCallIds?: readonly string[];
  executeButlerTool: ContextualButlerToolExecutor;
}): Promise<unknown> {
  if (isDurableWorkTool(input.call.name) &&
      input.call.name !== "replace_work_plan" &&
      !isWorkRelationshipTool(input.call.name)) {
    await safeBindOpenWork(input.durableWork, input.workScope);
    await backfillTurnToolResults(
      { durableWork: input.durableWork, toolJournal: input.toolJournal },
      input.workScope,
    );
  }
  if (isDurableWorkTool(input.call.name)) {
    return executeDurableWorkTool({
      service: input.durableWork,
      scope: input.workScope,
      mutationCallId: input.callId,
      name: input.call.name,
      args: input.call.args,
      priorToolCallIds: input.priorToolCallIds,
    });
  }
  return input.executeButlerTool({
    ...input.call,
    signal: input.toolSignal,
  }, { effectOccurrenceId: input.callId });
}
