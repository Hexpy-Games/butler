import type {
  BtccAfterToolBatchDisposition,
  BtccAgentLoopInput,
  BtccAgentLoopToolCall,
  BtccAgentLoopToolResult,
} from "./contracts.ts";
import type { DurableWorkService } from "../work/index.ts";
import { isFreshCurrentDisposition } from "./guided-turn-closeout.ts";

/** A still-current Work disposition closes the current Turn's execution phase. */
export function createGuidedToolBatchTransition(input: {
  turnId: string;
  durableWork: DurableWorkService;
}): NonNullable<BtccAgentLoopInput["afterToolBatch"]> {
  return async (batch): Promise<BtccAfterToolBatchDisposition> => {
    if (batch.toolResults.some((result) => result.name === "wait_for_worker" &&
      result.ok && result.output && typeof result.output === "object" &&
      Reflect.get(result.output, "status") === "waiting")) return "wait";
    if (!hasSuccessfulDisposition(batch.toolCalls, batch.toolResults)) {
      return "continue";
    }
    const work = await input.durableWork.boundWorkForTurn(input.turnId)
      .catch(() => null);
    return work && isFreshCurrentDisposition(work, input.turnId)
      ? "final_report"
      : "continue";
  };
}

function hasSuccessfulDisposition(
  toolCalls: readonly BtccAgentLoopToolCall[],
  toolResults: readonly BtccAgentLoopToolResult[],
): boolean {
  const finalIndex = toolCalls.length - 1;
  return finalIndex >= 0 &&
    toolCalls[finalIndex]?.name === "record_work_disposition" &&
    toolResults[finalIndex]?.ok === true;
}
