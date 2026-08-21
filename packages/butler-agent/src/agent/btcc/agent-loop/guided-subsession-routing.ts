import type { ButlerExecutionPolicy } from "../contracts.ts";
import type { TurnRecord } from "../turn/index.ts";
import type { BtccAgentLoopInput, BtccAgentLoopToolDefinition } from "./contracts.ts";
import type { BtccRoundToolSurfaceSnapshot } from "./round-tool-surface.ts";
import { createRoundToolSurfaceSnapshot } from "./round-tool-surface.ts";
import { requiresStewardDelegationIntent } from "./guided-delegation-intent.ts";

const SUBSESSION_ROUTING_TOOL_NAMES = new Set([
  "delegate_to_steward",
  "steer_steward",
  "cancel_steward",
]);

export function requiresAppSubsessionRouting(input: {
  turn: TurnRecord;
  policy: Pick<ButlerExecutionPolicy, "role">;
  hasSubsessionResultEvidence: boolean;
}): boolean {
  return input.turn.progressDestination?.transport === "app" &&
    input.policy.role === "butler" &&
    !input.hasSubsessionResultEvidence &&
    requiresStewardDelegationIntent(input.turn.originalMessage);
}

export function guidedSubsessionRoutingLoopControls(input: {
  repairRequired: () => boolean;
  resolveTools?: () => Promise<BtccRoundToolSurfaceSnapshot>;
}): Pick<BtccAgentLoopInput, "resolveTools" | "resolveToolChoice"> {
  return {
    ...(input.resolveTools
      ? {
          resolveTools: async () => {
            const snapshot = await input.resolveTools!();
            return input.repairRequired()
              ? routingOnlySnapshot(snapshot.tools)
              : snapshot;
          },
        }
      : {}),
    resolveToolChoice: () => input.repairRequired() ? "required" : "auto",
  };
}

function routingOnlySnapshot(
  tools: readonly BtccAgentLoopToolDefinition[],
): BtccRoundToolSurfaceSnapshot {
  return createRoundToolSurfaceSnapshot(tools.filter((tool) =>
    SUBSESSION_ROUTING_TOOL_NAMES.has(tool.name),
  ));
}
