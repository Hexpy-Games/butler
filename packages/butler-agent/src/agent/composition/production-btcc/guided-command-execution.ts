import type { GuidedEffectAccessMode } from "../../btcc/effects/index.ts";
import type { ButlerToolCall } from "../../tools/butler-tools.ts";
import { executeGuidedReadOnlyCommand } from "./guided-read-only-command.ts";
import { executeGuidedValidationCommand } from "./guided-validation-command.ts";

export async function executeGuidedCommandCall(input: {
  call: ButlerToolCall;
  accessMode: GuidedEffectAccessMode;
  butlerData: string;
  workspacePath: string;
  originalRequest: string;
  signal: AbortSignal;
}): Promise<unknown> {
  const stateEffect = input.call.args.state_effect ?? "read_only";
  if (
    stateEffect === "validation" &&
    input.accessMode === "full_access" &&
    nonEmptyString(input.call.args.validation_suite)
  ) {
    return await executeGuidedValidationCommand({
      args: input.call.args,
      butlerData: input.butlerData,
      workspacePath: input.workspacePath,
      originalRequest: input.originalRequest,
      signal: input.call.signal ?? input.signal,
    });
  }
  return await executeGuidedReadOnlyCommand({
    args: input.call.args,
    butlerData: input.butlerData,
    workspacePath: input.workspacePath,
    originalRequest: input.originalRequest,
    signal: input.call.signal ?? input.signal,
  });
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}
