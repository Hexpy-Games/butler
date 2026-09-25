import type {
  BtccAfterToolBatchDisposition,
  BtccAgentLoopInput,
  BtccAgentLoopToolCall,
  BtccAgentLoopToolResult,
} from "./contracts.ts";
import type { DurableWorkService } from "../work/index.ts";
import { guidedWorkReportDecision } from "./guided-work-report-decision.ts";

/** Only a reportable Work disposition closes this execution phase. */
export function createGuidedToolBatchTransition(input: {
  turnId: string;
  durableWork: DurableWorkService;
  shouldWaitForWorker: () => Promise<boolean>;
  requiresTerminalResult?: boolean;
}): NonNullable<BtccAgentLoopInput["afterToolBatch"]> {
  return async (batch): Promise<BtccAfterToolBatchDisposition> => {
    if (batch.toolResults.some((result) => result.name === "wait_for_worker" &&
      result.ok && result.output && typeof result.output === "object" &&
      Reflect.get(result.output, "status") === "waiting")) return "wait";
    // A newly queued assignment permits another management round, and a
    // rejected management call must reach the model. A repeated assignment or
    // an accepted steer changes nothing to manage now, so it yields to waiting.
    const managementNeedsModel = batch.toolResults.some((result) =>
      (result.name === "delegate_to_worker" || result.name === "steer_worker") && (!result.ok ||
        (result.name === "delegate_to_worker" && result.output && typeof result.output === "object" &&
          Reflect.get(result.output, "status") === "queued")),
    );
    if (managementNeedsModel) return "continue";
    if (await input.shouldWaitForWorker()) return "wait";
    if (!hasSuccessfulDisposition(batch.toolCalls, batch.toolResults)) {
      return "continue";
    }
    const work = await input.durableWork.boundWorkForTurn(input.turnId);
    return work && guidedWorkReportDecision(work, input.turnId, input.requiresTerminalResult ?? false).status === "report"
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
