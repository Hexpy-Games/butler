import {
  readPromptCacheMetrics,
  type PromptCacheMetricEvent,
} from "../../../../integrations/providers/prompt-cache-metrics.ts";
import { readContextMonitor } from "../../../../operations/metrics/context-monitor.ts";
import type { ContextDetailsView } from "../../interface/protocol/app-protocol.ts";

const RESERVED_CONTEXT_SOURCE_KINDS = new Set([
  "output_reserve",
  "tool_reserve",
  "compaction_reserve",
]);

export function contextCategory(
  id: string,
  label: string,
  usedTokens: number,
  sourceKind: ContextDetailsView["categories"][number]["source_kind"],
  budgetTokens: number,
  safeDescription?: string,
): ContextDetailsView["categories"][number] {
  return {
    id,
    label,
    used_tokens: usedTokens,
    budget_tokens: budgetTokens,
    ratio: budgetTokens > 0 ? usedTokens / budgetTokens : 0,
    safe_description:
      safeDescription ?? `${usedTokens.toLocaleString("en-US")} tokens`,
    source_kind: sourceKind,
  };
}

export function isReservedContextCategory(
  category: ContextDetailsView["categories"][number],
): boolean {
  return RESERVED_CONTEXT_SOURCE_KINDS.has(category.source_kind);
}

export function reconcileOccupiedCategoryTokens(
  categories: ContextDetailsView["categories"],
  targetTokens: number,
): ContextDetailsView["categories"] {
  const target = Math.max(0, Math.round(targetTokens));
  const occupiedIndexes = categories.flatMap((category, index) =>
    isReservedContextCategory(category) ? [] : [index],
  );
  const occupiedTotal = occupiedIndexes.reduce(
    (sum, index) => sum + (categories[index]?.used_tokens ?? 0),
    0,
  );
  if (occupiedIndexes.length === 0 || occupiedTotal === target)
    return categories;

  const adjusted = categories.map((category) => ({ ...category }));
  if (occupiedTotal < target) {
    const workingIndex =
      occupiedIndexes.find((index) => adjusted[index]?.id === "working") ??
      occupiedIndexes.at(-1)!;
    const working = adjusted[workingIndex];
    if (working) working.used_tokens += target - occupiedTotal;
  } else {
    let remaining = occupiedTotal - target;
    for (
      let index = occupiedIndexes.length - 1;
      index >= 0 && remaining > 0;
      index -= 1
    ) {
      const categoryIndex = occupiedIndexes[index]!;
      const category = adjusted[categoryIndex];
      if (!category) continue;
      const reduction = Math.min(category.used_tokens, remaining);
      category.used_tokens -= reduction;
      remaining -= reduction;
    }
  }

  return adjusted.map((category) => ({
    ...category,
    ratio:
      category.budget_tokens > 0
        ? category.used_tokens / category.budget_tokens
        : 0,
  }));
}

export function latestLivePromptUsage(input: {
  butlerData: string;
  runtimeSessionId: string;
  turnId?: string;
  latestTurnStartedAt?: string | number;
  currentModelRef?: string;
}): { promptTokens: number; source: string; ts: number } | null {
  const promptMetrics = readPromptCacheMetrics({
    butlerData: input.butlerData,
  });
  const exactProvider = latestProviderPromptUsage({
    events: promptMetrics,
    turnId: input.turnId,
    runtimeSessionId: input.runtimeSessionId,
  });
  // An exact Turn metric is authoritative even if another monitor event was
  // written later. It is the only provider sample that can be correlated to
  // the current model prompt without compatibility assumptions.
  if (exactProvider) return exactProvider;

  const contextMonitor = latestContextMonitorPromptUsage(input);

  const legacyProvider = latestLegacyProviderPromptUsage({
    events: promptMetrics,
    runtimeSessionId: input.runtimeSessionId,
    latestTurnStartedAt: input.latestTurnStartedAt,
  });
  if (!legacyProvider) return contextMonitor;
  if (!contextMonitor) return legacyProvider;
  return contextMonitor.ts > legacyProvider.ts
    ? contextMonitor
    : legacyProvider;
}

function latestProviderPromptUsage(input: {
  events: PromptCacheMetricEvent[];
  turnId?: string;
  runtimeSessionId: string;
}): { promptTokens: number; source: string; ts: number } | null {
  const turnId = input.turnId?.trim();
  if (!turnId) return null;
  let latest: { promptTokens: number; source: string; ts: number } | null =
    null;
  for (const event of input.events) {
    if (
      event.turnId !== turnId ||
      event.scope !== `btcc-guided:${input.runtimeSessionId}`
    )
      continue;
    if (
      !Number.isFinite(event.ts) ||
      !Number.isFinite(event.promptTokens) ||
      event.promptTokens <= 0
    ) {
      continue;
    }
    if (!latest || event.ts >= latest.ts) {
      latest = {
        promptTokens: Math.max(0, Math.round(event.promptTokens)),
        source: "provider_prompt_usage",
        ts: event.ts,
      };
    }
  }
  return latest;
}

function latestLegacyProviderPromptUsage(input: {
  events: PromptCacheMetricEvent[];
  runtimeSessionId: string;
  latestTurnStartedAt?: string | number;
}): { promptTokens: number; source: string; ts: number } | null {
  const latestTurnStart = timestampMs(input.latestTurnStartedAt);
  if (latestTurnStart === null) return null;
  const guidedScope = `btcc-guided:${input.runtimeSessionId}`;
  let latest: { promptTokens: number; source: string; ts: number } | null =
    null;
  for (const event of input.events) {
    // Compatibility is deliberately narrower than exact Turn attribution:
    // only unattributed samples from this session's guided scope can qualify.
    const hasTurnAttribution = Object.prototype.hasOwnProperty.call(
      event,
      "turnId",
    );
    if (
      hasTurnAttribution ||
      event.scope !== guidedScope ||
      !Number.isFinite(event.ts) ||
      event.ts < latestTurnStart ||
      !Number.isFinite(event.promptTokens) ||
      event.promptTokens <= 0
    ) {
      continue;
    }
    if (!latest || event.ts >= latest.ts) {
      latest = {
        promptTokens: Math.max(0, Math.round(event.promptTokens)),
        source: "provider_prompt_usage",
        ts: event.ts,
      };
    }
  }
  return latest;
}

function timestampMs(value: string | number | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function latestContextMonitorPromptUsage(input: {
  butlerData: string;
  runtimeSessionId: string;
  latestTurnStartedAt?: string | number;
  currentModelRef?: string;
}): { promptTokens: number; source: string; ts: number } | null {
  const summary = readContextMonitor({
    butlerData: input.butlerData,
    sessionId: input.runtimeSessionId,
  });
  const latestTurn = summary.latestTurn;
  if (!latestTurn || latestTurn.estimatedTokens <= 0) return null;
  const latestTurnStart = timestampMs(input.latestTurnStartedAt);
  if (latestTurnStart !== null && latestTurn.ts < latestTurnStart) return null;
  const currentModel = input.currentModelRef?.trim();
  const monitorModel = latestTurn.model?.trim();
  if (currentModel && monitorModel && currentModel !== monitorModel)
    return null;
  return {
    promptTokens: Math.max(0, Math.round(latestTurn.estimatedTokens)),
    source: "context_monitor",
    ts: latestTurn.ts,
  };
}
