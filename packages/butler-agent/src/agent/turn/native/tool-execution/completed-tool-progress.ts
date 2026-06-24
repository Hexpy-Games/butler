import { sanitizePublicText } from "../../../events/turn-events.ts";
import type { ToolProgressSummary } from "../output/tool-types.ts";

export function completedToolProgressSummary(
  progress: ToolProgressSummary,
  result: unknown,
): ToolProgressSummary {
  if (progress.toolName !== "Web search") return progress;
  const plannedQueries = smartSearchPlannedQueries(result);
  if (plannedQueries.length === 0) return progress;
  const count = plannedQueries.length;
  const countLabel = `${count} planned ${count === 1 ? "query" : "queries"}`;
  return {
    ...progress,
    safeLabel: `Smart web search: ${countLabel}`,
    inputLabel: countLabel,
    detailRows: plannedQueries.map((query, index) => ({
      id: `web-search-planned-query-${index + 1}`,
      kind: "query",
      safe_label: `Planned query ${index + 1}`,
      safe_value: query,
      state: "delivered",
    })),
  };
}

function smartSearchPlannedQueries(result: unknown): string[] {
  if (!isRecord(result)) return [];
  const plan = result.search_plan;
  if (!isRecord(plan) || plan.mode !== "smart") return [];
  const queries = plan.queries;
  if (!Array.isArray(queries)) return [];
  return queries
    .map((item) => {
      if (!isRecord(item)) return "";
      return typeof item.query === "string"
        ? sanitizePublicText(item.query, "planned query").slice(0, 220)
        : "";
    })
    .filter((query) => query && query !== "planned query")
    .slice(0, 8);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
