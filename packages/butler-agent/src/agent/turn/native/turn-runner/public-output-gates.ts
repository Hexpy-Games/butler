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
  finalResultContractRepairPrompt,
  stripLeadingPublicWorkDecisionBlock,
  stripToolImplementationLeakLines,
} from "../../../output/final-output-contract.ts";
import { finalContractFallbackText } from "../policy/turn-evidence-gates.ts";
import { recordIntentGuardMetric } from "./intent-guard-metrics.ts";
import type { NativeStoredSessionConfig, NativeTurnRunnerDeps } from "./turn-runner-types.ts";
import type { PublicWorkDecision, ToolAuditEntry } from "../output/tool-types.ts";

export async function repairFinalContract(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  deps: NativeTurnRunnerDeps;
  useTools: boolean;
  prompt: string;
  finalText: string;
  audit: ToolAuditEntry[];
  publicDecisionContext: PublicWorkDecision[];
  runToolPrompt(promptText: string, maxToolRounds?: number, phase?: string): Promise<string>;
}): Promise<string> {
  const successfulToolNames = input.audit.filter((entry) => entry.ok).map((entry) => entry.name);
  const finalNeedsContractRepair = containsFinalPublicWorkDecisionLeak(input.finalText) ||
    containsFinalToolImplementationLeak(input.finalText, successfulToolNames);
  if (!input.useTools || !finalNeedsContractRepair) return input.finalText;
  const repairedFinalText = await input.runToolPrompt(finalResultContractRepairPrompt({
    prompt: input.prompt,
    previousAnswer: input.finalText,
    audit: input.audit,
    decisions: input.publicDecisionContext,
  }), 1, "final_contract_repair");
  const repairedStillLeaks = containsFinalPublicWorkDecisionLeak(repairedFinalText) ||
    containsFinalToolImplementationLeak(repairedFinalText, successfulToolNames);
  const strippedFinalText = repairedStillLeaks
    ? stripToolImplementationLeakLines(stripLeadingPublicWorkDecisionBlock(repairedFinalText), successfulToolNames)
    : "";
  recordOperationalMetric({
    category: "runtime",
    name: "final_result_contract_guard",
    status: "ok",
    dimensions: {
      role: input.session.init.role,
      runtime: input.deps.runtimeId,
      model: input.turnInput.model,
      detail: repairedStillLeaks ? "fallback" : "repair",
    },
  }, { butlerData: input.deps.butlerData });
  return repairedStillLeaks
    ? strippedFinalText || finalContractFallbackText(input.deps.messageLanguage)
    : repairedFinalText;
}

export function applyPublicOutputGuards(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  deps: NativeTurnRunnerDeps;
  useTools: boolean;
  userText: string;
  finalText: string;
  audit: ToolAuditEntry[];
}): string {
  const intentGuardDecision = input.useTools && shouldEnforceGrounding(input.turnInput)
    ? applyRuntimeIntentGuardsWithDecision({
        userText: input.userText,
        responseText: input.finalText,
        audit: input.audit,
        language: input.deps.messageLanguage,
      })
    : { text: input.finalText, guard: "none" as const };
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
  return input.useTools
    ? applyWebSearchCitationGuard({
        text: intentGuardDecision.text,
        audit: input.audit,
      })
    : intentGuardDecision.text;
}
