import type { ButlerToolExecutorRegistry } from "../../tool-execution-contracts.ts";
import { readOperationResultsToolDefinition } from "./definition.ts";

export function createReadOperationResultsHandler(
  read: (args: Record<string, unknown>) => unknown,
): ButlerToolExecutorRegistry {
  return {
    [readOperationResultsToolDefinition.name]: (call) => read(call.args),
  };
}
