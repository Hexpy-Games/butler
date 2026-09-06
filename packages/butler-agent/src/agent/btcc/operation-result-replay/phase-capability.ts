import type { FunctionToolDefinition } from
  "../../../integrations/providers/runtime-contracts.ts";
import { operationResultReplayEnabled } from "./operation-result-replay.ts";
import { readOperationResultsToolDefinition, listOperationResultsToolDefinition } from
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
    exactReadCapability: true,
  };
}

export function admitExactResultReadTool(
  tools: readonly FunctionToolDefinition[],
  selection: ExactResultReplayPhaseSelection,
): FunctionToolDefinition[] {
  if (!selection.exactReadCapability) return [...tools];
  return [...tools, ...[readOperationResultsToolDefinition, listOperationResultsToolDefinition]
    .filter((definition) => !tools.some((tool) => tool.name === definition.name))];
}

export function isExactResultReadTool(name: string): boolean {
  return name === readOperationResultsToolDefinition.name || name === listOperationResultsToolDefinition.name;
}
