import { recordOperationalMetric } from "../../../../operations/metrics/operational-metrics.ts";
import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import {
  applyRuntimeIntentGuardsWithDecision,
  applyWebSearchCitationGuard,
  shouldEnforceGrounding,
} from "../../../policy/runtime-policy.ts";
import {
  containsFinalPublicWorkDecisionLeak,
  containsFinalToolImplementationLeak,
  stripLeadingPublicWorkDecisionBlock,
  stripToolImplementationLeakLines,
} from "../../../output/completion/final-output-contract.ts";
import { finalContractFallbackText } from "../policy/turn-evidence-gates.ts";
import { recordIntentGuardMetric } from "./intent-guard-metrics.ts";
import type { NativeStoredSessionConfig, NativeTurnRunnerDeps } from "./turn-runner-types.ts";
import type { PublicWorkDecision, ToolAuditEntry } from "../output/tool-types.ts";
import type { CompiledTurnContract } from "../../turn-contract.ts";

export function repairFinalContract(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  deps: NativeTurnRunnerDeps;
  useTools: boolean;
  prompt: string;
  finalText: string;
  audit: ToolAuditEntry[];
  publicDecisionContext: PublicWorkDecision[];
}): string {
  const successfulToolNames = input.audit.filter((entry) => entry.ok).map((entry) => entry.name);
  const finalContainsDecisionLeak = containsFinalPublicWorkDecisionLeak(input.finalText);
  const finalContainsToolLeak = containsFinalToolImplementationLeak(input.finalText, successfulToolNames);
  const finalNeedsContractRepair = finalContainsDecisionLeak || finalContainsToolLeak;
  const shouldRepairFinalContract = input.useTools && finalNeedsContractRepair;
  if (!shouldRepairFinalContract) {
    return input.finalText;
  }
  const strippedFinalText = stripToolImplementationLeakLines(
    stripLeadingPublicWorkDecisionBlock(input.finalText),
    successfulToolNames,
  );
  recordOperationalMetric({
    category: "runtime",
    name: "final_result_contract_guard",
    status: "ok",
    dimensions: {
      role: input.session.init.role,
      runtime: input.deps.runtimeId,
      model: input.turnInput.model,
      detail: "local_strip",
    },
  }, { butlerData: input.deps.butlerData });
  return strippedFinalText || finalContractFallbackText(input.deps.messageLanguage);
}

export function applyPublicOutputGuards(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  deps: NativeTurnRunnerDeps;
  useTools: boolean;
  userText: string;
  finalText: string;
  audit: ToolAuditEntry[];
  turnContract?: CompiledTurnContract;
}): string {
  const intentGuardDecision = getIntentGuardDecision(input);
  if (intentGuardDecision.guard !== "none") {
    recordIntentGuardMetric({
      butlerData: input.deps.butlerData,
      role: input.session.init.role,
      runtime: input.deps.runtimeId,
      model: input.turnInput.model,
      guard: intentGuardDecision.guard,
      detail: intentGuardDecision.detail ?? "none",
    });
  }
  const shouldApplyCitationGuard = input.useTools;
  if (!shouldApplyCitationGuard) {
    return intentGuardDecision.text;
  }
  return applyWebSearchCitationGuard({
    text: intentGuardDecision.text,
    audit: input.audit,
  });
}

function getIntentGuardDecision(input: {
  turnInput: RuntimeTurnInput;
  deps: NativeTurnRunnerDeps;
  useTools: boolean;
  userText: string;
  finalText: string;
  audit: ToolAuditEntry[];
  turnContract?: CompiledTurnContract;
}): ReturnType<typeof applyRuntimeIntentGuardsWithDecision> | { text: string; guard: "none" } {
  if (input.turnContract?.action === "tool_answer") {
    return { text: input.finalText, guard: "none" };
  }
  const shouldApplyIntentGuard = input.useTools && shouldEnforceGrounding(input.turnInput);
  if (!shouldApplyIntentGuard) {
    return { text: input.finalText, guard: "none" };
  }
  return applyRuntimeIntentGuardsWithDecision({
    userText: input.userText,
    responseText: input.finalText,
    audit: input.audit,
    language: input.deps.messageLanguage,
  });
}
