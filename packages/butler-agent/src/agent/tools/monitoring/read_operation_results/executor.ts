import type { ButlerToolExecutorRegistry } from "../../tool-execution-contracts.ts";
import { readOperationResultsToolDefinition, listOperationResultsToolDefinition } from "./definition.ts";

export function createReadOperationResultsHandler(
  read: (args: Record<string, unknown>) => unknown,
): ButlerToolExecutorRegistry {
  return {
    [listOperationResultsToolDefinition.name]: (call) => read({ ...call.args, __list: true }),
    [readOperationResultsToolDefinition.name]: (call) => read(call.args),
  };
}
