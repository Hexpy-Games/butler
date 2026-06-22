import type { WebSearchOutput } from "../../../../integrations/search/provider.ts";
import { createEvidenceCapabilityReceipt } from "../../../output/evidence-capability-ledger.ts";
import { urlReferences } from "../../../tool-support/executor-support.ts";

export function webSearchEvidenceCapabilityReceipts(output: WebSearchOutput) {
  return [
    createEvidenceCapabilityReceipt({
      producer: { kind: "tool", name: "web_search" },
      capability: "source_candidate",
      evidence_kind: "source_candidate",
      maturity: "candidate",
      verified: false,
      confidence: output.results.length > 0 ? 0.45 : 0.15,
      summary: output.results.length > 0
        ? "Search returned public source candidates for later verification."
        : "Search completed without public source candidates.",
      references: urlReferences(output.results.map((result) => result.url)).filter((reference) =>
        isHttpUrl(reference.ref),
      ).map((reference) => ({
        ...(reference.label ? { label: reference.label } : {}),
        url: reference.ref,
      })),
      limitations: ["Search candidate discovery is not source verification."],
    }),
  ];
}

export function readRequirementForSearchOutput(output: WebSearchOutput & {
  search_plan?: Record<string, unknown>;
}): Record<string, unknown> {
  const plan = output.search_plan;
  const depth = typeof plan?.depth === "string" ? plan.depth : "";
  const verificationRequired = plan?.verification_required === true;
  const readRequired = verificationRequired || depth === "deep" || depth === "verification";
  if (!readRequired) return {};
  return {
    read_required: true,
    read_reason: "The search plan requires page evidence before making confident source-backed claims.",
    recommended_read_urls: output.results
      .map((result) => result.url)
      .filter((url) => typeof url === "string" && url.trim().length > 0)
      .slice(0, 4),
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function coverageBudgetForSearchOutput(output: WebSearchOutput, requestedLimit: number): Record<string, unknown> {
  return {
    mode: "coverage_based",
    result_count: output.results.length,
    stop_reason: output.results.length === 0
      ? "no_source_candidates"
      : output.results.length >= requestedLimit
        ? "candidate_limit_reached"
        : "provider_results_exhausted",
    next_search_guidance:
      "Run another search only for a specific missing outcome field, category, source type, or verification gap.",
  };
}
