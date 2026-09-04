import type { DurableWorkView } from "../work/index.ts";
import type { BtccAgentLoopToolDefinition } from "./contracts.ts";

/** Work schemas stay stable; current admissibility is returned by Work policy/context. */
export function projectDurableWorkToolSurface(
  tools: readonly BtccAgentLoopToolDefinition[],
  _work: DurableWorkView | undefined,
): BtccAgentLoopToolDefinition[] {
  return [...tools];
}
