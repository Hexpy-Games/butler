import { isDurableWorkTool } from "../work/index.ts";
import type { GuidedActivityBinding } from "../projection/index.ts";
import type { GuidedToolCallExecutionInput } from "./guided-tool-call-execution.ts";
import {
  ordinaryToolError,
  publishOperation,
  safeJson,
} from "./guided-tool-progress.ts";
import { safeAttachToolResult } from "./guided-work-runtime.ts";

export async function finishFailedTool(
  input: GuidedToolCallExecutionInput,
  toolName: string,
  callId: string,
  effectiveToolName: string,
  args: Record<string, unknown>,
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
      args,
      status: "failed",
      resultJson: safeJson(result),
    });
    return result;
  }
  input.toolJournal.finish({ callId, status: "cancelled", errorCode: "cancelled" });
  await publishOperation(input.progress, {
    turnId: input.turn.turnId,
    activityId: activity.activityId,
    requestId: callId,
    toolName: effectiveToolName,
    args,
    status: "cancelled",
  });
  throw error;
}
