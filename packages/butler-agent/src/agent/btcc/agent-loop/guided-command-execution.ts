import type { GuidedEffectAccessMode } from "../effects/index.ts";
import type { ButlerToolCall } from "../../tools/butler-tools.ts";
import { executeGuidedReadOnlyCommand } from "./guided-read-only-command.ts";

export async function executeGuidedCommandCall(input: {
  call: ButlerToolCall;
  accessMode: GuidedEffectAccessMode;
  butlerData: string;
  workspacePath: string;
  originalRequest: string;
  signal: AbortSignal;
  executeRegistered(): Promise<unknown>;
}): Promise<unknown> {
  const stateEffect = input.call.args.state_effect ?? "read_only";
  if (
    input.accessMode === "full_access" &&
    (stateEffect === "read_only" || stateEffect === "validation")
  ) {
    return await input.executeRegistered();
  }
  return await executeGuidedReadOnlyCommand({
    args: input.call.args,
    butlerData: input.butlerData,
    workspacePath: input.workspacePath,
    originalRequest: input.originalRequest,
    signal: input.call.signal ?? input.signal,
  });
}
