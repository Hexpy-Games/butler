import type {
  BtccAgentLoopInput,
  BtccAgentLoopEvent,
  BtccAgentLoopMessage,
  BtccAgentLoopToolResult,
} from "./contracts.ts";

const DEFAULT_EXECUTION_WINDOW_SIZE = 8;

export function resolveExecutionWindowSize(input: BtccAgentLoopInput): number {
  return Math.max(1, input.maxIterations ?? DEFAULT_EXECUTION_WINDOW_SIZE);
}

export function throwIfExecutionWindowAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("BTCC agent loop was aborted");
}

export async function requestExecutionWindowObservation(input: {
  callback: BtccAgentLoopInput["onExecutionWindowBoundary"];
  signal?: AbortSignal;
  windowIndex: number;
  iteration: number;
  messages: readonly BtccAgentLoopMessage[];
  toolResults: readonly BtccAgentLoopToolResult[];
}): Promise<string | undefined> {
  throwIfExecutionWindowAborted(input.signal);
  const observation = await input.callback?.({
    windowIndex: input.windowIndex,
    iteration: input.iteration,
    messages: input.messages,
    toolResults: input.toolResults,
  });
  if (observation === undefined) return undefined;
  const normalized = observation.trim();
  if (!normalized) throw new Error("btcc_execution_window_observation_missing");
  return normalized;
}

export async function emitExecutionWindowBoundary(input: {
  events: BtccAgentLoopEvent[];
  onEvent: BtccAgentLoopInput["onEvent"];
  callback: BtccAgentLoopInput["onExecutionWindowBoundary"];
  signal?: AbortSignal;
  windowIndex: number;
  iteration: number;
  messages: readonly BtccAgentLoopMessage[];
  toolResults: readonly BtccAgentLoopToolResult[];
}): Promise<string | undefined> {
  const event: BtccAgentLoopEvent = {
    type: "execution_window_boundary",
    iteration: input.iteration,
    windowIndex: input.windowIndex,
  };
  input.events.push(event);
  input.onEvent?.(event);
  return requestExecutionWindowObservation(input);
}
