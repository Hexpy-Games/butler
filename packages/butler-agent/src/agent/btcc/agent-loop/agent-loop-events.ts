import type { BtccAgentLoopEvent, BtccAgentLoopInput } from "./contracts.ts";

export function emitAgentLoopEvent(
  events: BtccAgentLoopEvent[],
  onEvent: BtccAgentLoopInput["onEvent"],
  event: BtccAgentLoopEvent,
): void {
  events.push(event);
  onEvent?.(event);
}
