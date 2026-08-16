import type { FunctionToolDefinition } from
  "../../../integrations/providers/runtime-contracts.ts";
import { operationResultReplayEnabled } from "./operation-result-replay.ts";
import { readOperationResultsToolDefinition } from
  "../../tools/monitoring/read_operation_results/index.ts";

export type ExactResultReplayPhaseSelection = {
  mode: "disabled" | "available";
  exactReadCapability: boolean;
};

export function selectExactResultReplayPhase(
  env: Record<string, string | undefined>,
): ExactResultReplayPhaseSelection {
  const enabled = operationResultReplayEnabled(env);
  return {
    mode: enabled ? "available" : "disabled",
    exactReadCapability: enabled,
  };
}

export function admitExactResultReadTool(
  tools: readonly FunctionToolDefinition[],
  selection: ExactResultReplayPhaseSelection,
): FunctionToolDefinition[] {
  return selection.exactReadCapability &&
      !tools.some((tool) => tool.name === readOperationResultsToolDefinition.name)
    ? [...tools, readOperationResultsToolDefinition]
    : [...tools];
}

export function isExactResultReadTool(name: string): boolean {
  return name === readOperationResultsToolDefinition.name;
}
