import type { BtccAgentLoopResult } from "./contracts.ts";
import { isDurableWorkTool } from "../work/index.ts";
import { routeForUsedTools } from "./guided-turn-policy.ts";
import type { ProjectLedgerPlan } from "../project-plan.ts";

export function guidedTurnResult(input: {
  content: string;
  terminalOutcome?: BtccAgentLoopResult["terminalOutcome"];
  suspension?: BtccAgentLoopResult["suspension"];
  authorityContinuation?: BtccAgentLoopResult["authorityContinuation"];
  workStatus?: BtccAgentLoopResult["workStatus"];
  acceptedWorkResult?: BtccAgentLoopResult["acceptedWorkResult"];
  runtimeFailure?: BtccAgentLoopResult["runtimeFailure"];
  artifacts?: BtccAgentLoopResult["artifacts"];
  changedFiles?: BtccAgentLoopResult["changedFiles"];
  plan?: ProjectLedgerPlan;
  modelIdentity?: BtccAgentLoopResult["modelIdentity"];
  usedTools: readonly string[];
  hasFinalWork: boolean;
}): BtccAgentLoopResult {
  return {
    content: input.content,
    ...(input.terminalOutcome ? { terminalOutcome: input.terminalOutcome } : {}),
    ...(input.suspension ? { suspension: input.suspension } : {}),
    ...(input.authorityContinuation ? { authorityContinuation: input.authorityContinuation } : {}),
    ...(input.workStatus ? { workStatus: input.workStatus } : {}),
    ...(input.acceptedWorkResult ? { acceptedWorkResult: input.acceptedWorkResult } : {}),
    ...(input.runtimeFailure ? { runtimeFailure: input.runtimeFailure } : {}),
    ...(input.artifacts?.length ? { artifacts: input.artifacts } : {}),
    ...(input.changedFiles?.length ? { changedFiles: input.changedFiles } : {}),
    ...(input.plan ? { plan: input.plan } : {}),
    ...(input.modelIdentity ? { modelIdentity: input.modelIdentity } : {}),
    route: routeForUsedTools(
      input.usedTools,
      input.hasFinalWork || input.usedTools.some(isDurableWorkTool),
    ),
  };
}
