import {
  createConfiguredWebSearchProvider,
  recordWebSearchMetric,
  type WebSearchInput,
  type WebSearchOutput,
  type WebSearchProvider,
} from "../../../../integrations/search/provider.ts";
import {
  createSmartSearchPlan,
  type SearchPlan,
  type SmartSearchPlanningInput,
  type SmartSearchPlanningResult,
} from "../../../../integrations/search/planning.ts";
import { evidenceReceipt, urlReferences } from "../../../tool-support/executor-support.ts";
import {
  coverageBudgetForSearchOutput,
  readRequirementForSearchOutput,
  webSearchEvidenceCapabilityReceipts,
} from "./evidence.ts";
import { publicWebSearchEvidenceItems } from "../../../output/evidence/public-web-evidence.ts";
type WebSearchToolCall = { args: Record<string, unknown> };

export function createWebSearchHandler(input: {
  butlerData: string;
  turnContext?: string;
  originalRequest?: string;
  workerModel?: string;
  plannerModel?: string;
  provider?: WebSearchProvider;
  planner?: (input: SmartSearchPlanningInput) => Promise<SmartSearchPlanningResult>;
}): (call: WebSearchToolCall) => Promise<Record<string, unknown>> {
  let smartSearchPlanningConsumed = false;
  return async (call) => {
    const query = typeof call.args.query === "string" ? call.args.query.trim() : "";
    if (query.length < 2) {
      throw new Error("web_search requires a query with at least 2 characters");
    }
    const allowedDomains = stringArray(call.args.allowed_domains);
    const blockedDomains = stringArray(call.args.blocked_domains);
    if (allowedDomains.length > 0 && blockedDomains.length > 0) {
      throw new Error("web_search cannot use allowed_domains and blocked_domains together");
    }
    const provider = createConfiguredWebSearchProvider({
      butlerData: input.butlerData,
      provider: input.provider,
    });
    try {
      const allowSmartPlanning = !smartSearchPlanningConsumed;
      const output = await runWebSearchWithOptionalPlanning({
        butlerData: input.butlerData,
        provider,
        turnContext: input.turnContext,
        originalRequest: input.originalRequest,
        plannerModel: input.plannerModel ?? input.workerModel,
        planner: allowSmartPlanning
          ? input.planner ?? (
            input.provider
              ? async () => ({
                plan: null,
                usedPlanner: false,
                attempts: 0,
                fallbackReason: "test provider bypasses search planning",
              })
              : undefined
          )
          : async () => ({
            plan: null,
            usedPlanner: false,
            attempts: 0,
            fallbackReason: "smart search planning already ran in this turn; direct follow-up search used",
          }),
        searchInput: {
          query,
          allowed_domains: allowedDomains.length > 0 ? allowedDomains : undefined,
          blocked_domains: blockedDomains.length > 0 ? blockedDomains : undefined,
          recency_days: typeof call.args.recency_days === "number" ? Math.max(1, Math.trunc(call.args.recency_days)) : undefined,
          max_results: typeof call.args.max_results === "number" ? Math.max(1, Math.min(10, Math.trunc(call.args.max_results))) : undefined,
        },
      });
      if (output.search_plan?.mode === "smart" || output.search_plan?.planner_used === true) {
        smartSearchPlanningConsumed = true;
      }
      recordWebSearchMetric({
        butlerData: input.butlerData,
        provider: output.provider,
        query,
      });
      return {
        ok: true,
        ...output,
        public_web_evidence_items: publicWebSearchEvidenceItems({ results: output.results }),
        evidence_capability_receipts: webSearchEvidenceCapabilityReceipts(output),
        evidence_receipts: [
          evidenceReceipt({
            producerName: "web_search",
            receiptType: "coverage",
            summary: "Search returned public source candidates for the requested evidence.",
            verified: output.results.length > 0,
            covers: ["source_candidates"],
            references: urlReferences(output.results.map((result) => result.url)),
            metrics: {
              result_count: output.results.length,
              search_requests: output.usage?.search_requests ?? 1,
            },
          }),
        ],
        citation_required: true,
        coverage_budget: coverageBudgetForSearchOutput(
          output,
          typeof call.args.max_results === "number" ? Math.max(1, Math.min(10, Math.trunc(call.args.max_results))) : 10,
        ),
        ...readRequirementForSearchOutput(output),
        source_urls: output.results.map((result) => result.url),
      };
    } catch (error) {
      recordWebSearchMetric({
        butlerData: input.butlerData,
        provider: provider.id,
        query,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function runWebSearchWithOptionalPlanning(input: {
  butlerData: string;
  provider: WebSearchProvider;
  searchInput: Required<Pick<WebSearchInput, "query">> & WebSearchInput;
  turnContext?: string;
  originalRequest?: string;
  plannerModel?: string;
  planner?: (input: SmartSearchPlanningInput) => Promise<SmartSearchPlanningResult>;
}): Promise<WebSearchOutput & {
  search_plan?: Record<string, unknown>;
}> {
  const planResult = await (input.planner ?? createSmartSearchPlan)({
    butlerData: input.butlerData,
    query: input.searchInput.query,
    originalRequest:
      input.originalRequest?.trim() ||
      boundedSearchPlannerOriginalRequest(input.turnContext),
    allowedDomains: input.searchInput.allowed_domains,
    blockedDomains: input.searchInput.blocked_domains,
    recencyDays: input.searchInput.recency_days,
    maxResults: input.searchInput.max_results,
    model: input.plannerModel,
  });

  if (!planResult.plan) {
    const direct = await input.provider.search(input.searchInput);
    return {
      ...direct,
      search_plan: {
        mode: "direct",
        planner_used: planResult.usedPlanner,
        planner_attempts: planResult.attempts,
        fallback_reason: planResult.fallbackReason ?? null,
        original_query: input.searchInput.query,
      },
    };
  }

  const output = await executePlannedWebSearch({
    provider: input.provider,
    searchInput: input.searchInput,
    plan: planResult.plan,
  });
  return {
    ...output,
    search_plan: compactSearchPlan(planResult.plan, planResult.attempts),
  };
}

function boundedSearchPlannerOriginalRequest(value: string | undefined): string | undefined {
  const compact = boundedPlannedSourceContext(value);
  if (!compact) return undefined;
  const maxChars = 3_000;
  if (compact.length <= maxChars) return compact;
  const marker = "\n[...current turn context trimmed for search planner...]\n";
  const headChars = Math.floor((maxChars - marker.length) * 0.7);
  const tailChars = maxChars - marker.length - headChars;
  return [
    compact.slice(0, headChars).trimEnd(),
    marker.trim(),
    compact.slice(Math.max(0, compact.length - tailChars)).trimStart(),
  ].filter(Boolean).join("\n");
}

async function executePlannedWebSearch(input: {
  provider: WebSearchProvider;
  searchInput: Required<Pick<WebSearchInput, "query">> & WebSearchInput;
  plan: SearchPlan;
}): Promise<WebSearchOutput> {
  const start = Date.now();
  const finalLimit = Math.max(
    1,
    Math.min(10, Math.trunc(input.searchInput.max_results ?? 10)),
  );
  const perQueryLimit = Math.max(2, Math.min(5, finalLimit));
  const plannedInputs = input.plan.queries.map((query) => ({
    ...input.searchInput,
    query: query.query,
    max_results: perQueryLimit,
  }));
  const outputs = await Promise.all(
    plannedInputs.map((plannedInput) => input.provider.search(plannedInput)),
  );

  const results = interleaveSearchResults(outputs, finalLimit);
  const providers = Array.from(new Set(outputs.map((output) => output.provider)));
  return {
    query: input.searchInput.query,
    results,
    duration_ms: Math.max(0, Date.now() - start),
    provider: providers.length === 1 ? providers[0]! : providers.join("+"),
    usage: {
      search_requests: outputs.reduce(
        (sum, output) => sum + (output.usage?.search_requests ?? 1),
        0,
      ),
    },
  };
}

function interleaveSearchResults(
  outputs: WebSearchOutput[],
  finalLimit: number,
): WebSearchOutput["results"] {
  const seenUrls = new Set<string>();
  const results: WebSearchOutput["results"] = [];
  const maxRows = Math.max(0, ...outputs.map((output) => output.results.length));
  for (let row = 0; row < maxRows && results.length < finalLimit; row += 1) {
    for (const output of outputs) {
      const result = output.results[row];
      if (!result) continue;
      const key = result.url.trim();
      if (!key || seenUrls.has(key)) continue;
      seenUrls.add(key);
      results.push(result);
      if (results.length >= finalLimit) break;
    }
  }
  return results;
}

function compactSearchPlan(
  plan: SearchPlan,
  attempts: number,
): Record<string, unknown> {
  return {
    mode: plan.mode,
    depth: plan.depth,
    intent: plan.intent,
    scope: plan.scope,
    parallelizable: plan.parallelizable,
    verification_required: plan.verificationRequired,
    planner_attempts: attempts,
    decomposition: plan.decomposition.map((bucket) => ({
      id: bucket.id,
      label: bucket.label,
      priority: bucket.priority,
    })),
    queries: plan.queries.map((query) => ({
      bucket_id: query.bucketId ?? null,
      query: query.query,
      purpose: query.purpose,
      priority: query.priority,
      expected_source_type: query.expectedSourceType ?? null,
    })),
  };
}

function boundedPlannedSourceContext(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const compact = compactPlannedSourceContext(value);
  return compact.length > 6_000
    ? compact.slice(0, 4_000) + "\n...[truncated]\n" + compact.slice(-2_000)
    : compact;
}

function compactPlannedSourceContext(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => {
      if (line.trim()) return true;
      return lines[index - 1]?.trim() && lines[index + 1]?.trim();
    })
    .join("\n")
    .trim();
}
