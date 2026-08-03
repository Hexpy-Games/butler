import type { ButlerToolExecutor } from "../../tools/butler-tools.ts";
import { unauthorizedToolResult, publishOperation, safeJson } from
  "./guided-tool-progress.ts";
import type { GuidedActivityBinding } from "../projection/index.ts";
import type { GuidedToolCallExecutionInput } from "./guided-tool-call-execution.ts";

export async function denyUnauthorizedTool(
  input: GuidedToolCallExecutionInput,
  callId: string,
  effectiveToolName: string,
  call: Parameters<ButlerToolExecutor>[0],
  presentationArgs: Record<string, unknown>,
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
      arguments: presentationArgs,
    });
    input.toolJournal.finish({ callId, status: "completed", result: denied });
  }
  const result = recorded?.result ?? denied;
  await publishOperation(input.progress, {
    turnId: input.turn.turnId,
    activityId: activity.activityId,
    requestId: callId,
    toolName: effectiveToolName,
    args: presentationArgs,
    status: "failed",
    resultJson: safeJson(result),
  });
  return result;
}
