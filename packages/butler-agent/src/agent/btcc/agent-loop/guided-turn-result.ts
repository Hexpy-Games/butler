import type { BtccAgentLoopResult } from "./contracts.ts";
import { isDurableWorkTool } from "../work/index.ts";
import { routeForUsedTools } from "./guided-turn-policy.ts";

export function guidedTurnResult(input: {
  content: string;
  artifacts?: BtccAgentLoopResult["artifacts"];
  modelIdentity?: BtccAgentLoopResult["modelIdentity"];
  usedTools: readonly string[];
  hasFinalWork: boolean;
}): BtccAgentLoopResult {
  return {
    content: input.content,
    ...(input.artifacts?.length ? { artifacts: input.artifacts } : {}),
    ...(input.modelIdentity ? { modelIdentity: input.modelIdentity } : {}),
    route: routeForUsedTools(
      input.usedTools,
      input.hasFinalWork || input.usedTools.some(isDurableWorkTool),
    ),
  };
}
