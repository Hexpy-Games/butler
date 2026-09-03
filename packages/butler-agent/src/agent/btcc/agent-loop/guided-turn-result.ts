import type { BtccAgentLoopResult } from "./contracts.ts";
import { isDurableWorkTool } from "../work/index.ts";
import { routeForUsedTools } from "./guided-turn-policy.ts";

export function guidedTurnResult(input: {
  content: string;
  terminalOutcome?: BtccAgentLoopResult["terminalOutcome"];
  executionOutcome?: BtccAgentLoopResult["executionOutcome"];
  workStatus?: BtccAgentLoopResult["workStatus"];
  artifacts?: BtccAgentLoopResult["artifacts"];
  changedFiles?: BtccAgentLoopResult["changedFiles"];
  modelIdentity?: BtccAgentLoopResult["modelIdentity"];
  usedTools: readonly string[];
  hasFinalWork: boolean;
}): BtccAgentLoopResult {
  return {
    content: input.content,
    ...(input.terminalOutcome ? { terminalOutcome: input.terminalOutcome } : {}),
    ...(input.executionOutcome ? { executionOutcome: input.executionOutcome } : {}),
    ...(input.workStatus ? { workStatus: input.workStatus } : {}),
    ...(input.artifacts?.length ? { artifacts: input.artifacts } : {}),
    ...(input.changedFiles?.length ? { changedFiles: input.changedFiles } : {}),
    ...(input.modelIdentity ? { modelIdentity: input.modelIdentity } : {}),
    route: routeForUsedTools(
      input.usedTools,
      input.hasFinalWork || input.usedTools.some(isDurableWorkTool),
    ),
  };
}
