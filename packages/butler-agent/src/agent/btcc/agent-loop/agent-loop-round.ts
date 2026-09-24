import type {
  BtccAgentLoopInput,
  BtccAgentLoopToolCall,
  BtccAgentLoopToolResult,
} from "./contracts.ts";

export async function nextTurnAfterToolBatch(
  input: BtccAgentLoopInput,
  toolCalls: readonly BtccAgentLoopToolCall[],
  toolResults: readonly BtccAgentLoopToolResult[],
  iteration: number,
): Promise<"continue" | "final_report" | "wait"> {
  return await input.afterToolBatch?.({ toolCalls, toolResults, iteration }) ?? "continue";
}

export function modelRoundRequestId(index: number, recoveryAttempt = 1): string {
  return `btcc-model-round-${index}${recoveryAttempt > 1 ? `:retry:${recoveryAttempt}` : ""}`;
}

export function throwIfAgentLoopAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("BTCC agent loop was aborted");
}
