import { recordOperationalMetric } from "../../../../operations/metrics/operational-metrics.ts";
import type { CompiledTurnContract } from "../../turn-contract.ts";

export function recordTurnContractMetric(input: {
  butlerData: string;
  name: "compiled" | "claim" | "evidence" | "continuation" | "terminal";
  status: "ok" | "error" | "skipped";
  contract: CompiledTurnContract;
  claimCode?: string;
}): void {
  recordOperationalMetric({
    category: "runtime",
    name: `typed_turn_contract_${input.name}`,
    status: input.status,
    value: metricValue(input),
    unit: metricUnit(input.name),
    dimensions: {
      action: input.contract.action,
      state: input.contract.state,
      trackingMode: input.contract.tracking_mode,
      terminalRule: input.contract.terminal_rule,
      deliverableCount: input.contract.deliverables.length,
      obligationCount: input.contract.required_evidence.length,
      evidenceReceiptCount: input.contract.evidence_receipt_ids.length,
      continuationCount: input.contract.continuation_commit_ids.length,
      ...(input.claimCode ? { claimCode: safeCode(input.claimCode) } : {}),
    },
  }, { butlerData: input.butlerData });
}

function metricValue(input: {
  name: "compiled" | "claim" | "evidence" | "continuation" | "terminal";
  contract: CompiledTurnContract;
}): number {
  if (input.name === "evidence") return input.contract.evidence_receipt_ids.length;
  if (input.name === "continuation") return input.contract.continuation_commit_ids.length;
  return 1;
}

function metricUnit(name: "compiled" | "claim" | "evidence" | "continuation" | "terminal"): string {
  if (name === "evidence") return "receipts";
  if (name === "continuation") return "commits";
  return "events";
}

function safeCode(value: string): string {
  const code = value.trim().replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 80);
  return code || "unknown";
}
