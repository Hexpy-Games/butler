import type { BenchmarkResultFile } from "./contracts.ts";
import { buildCampaignResult } from "./m1-v2-aggregate.ts";
import type { M1V2CampaignResult } from "./m1-v2-types.ts";

export function summarizeM1V2Campaign(
  result: BenchmarkResultFile,
): M1V2CampaignResult | null {
  if (result.plan.campaign !== "m1-v2") return null;
  return buildCampaignResult(
    Math.max(0, ...result.plan.arms.map((arm) => arm.repetition)),
    result.observations.flatMap((observation) =>
      observation.m1V2 ? [observation.m1V2] : []),
  );
}

export function m1V2ReportLines(campaign: M1V2CampaignResult | null): string[] {
  if (!campaign) return [];
  return [
    "## M1 v2 eligibility and Butler cost",
    "",
    `- Complete: ${campaign.complete}`,
    `- Accepted: ${campaign.counts.accepted}`,
    `- Rejected: ${campaign.counts.rejected}`,
    `- Gated: ${campaign.counts.gated}`,
    "- Provider usage remains nullable; retry/cache/identity failures are ineligible and are not replacement observations.",
    "- Agent causal provider-send bytes are reported separately from per-role overhead and explicit all-physical totals.",
    "- Work/Ledger, memory, source, schema, replay, and carrier byte costs remain separated in the machine-readable summary.",
    "",
  ];
}
