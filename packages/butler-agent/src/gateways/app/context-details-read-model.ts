import { readPromptCacheMetrics } from "../../integrations/providers/prompt-cache-metrics.ts";
import { readContextMonitor } from "../../operations/metrics/context-monitor.ts";
import type { ContextDetailsView } from "./protocol.ts";

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
    ratio: usedTokens / budgetTokens,
    safe_description:
      safeDescription ?? `${usedTokens.toLocaleString("en-US")} tokens`,
    source_kind: sourceKind,
  };
}

export function latestLivePromptUsage(input: {
  butlerData: string;
  runtimeSessionId: string;
  turnId?: string;
}): { promptTokens: number; source: string; ts: number } | null {
  const provider = latestProviderPromptUsage(input);
  const contextMonitor = latestContextMonitorPromptUsage(input);
  if (!provider) return contextMonitor;
  if (!contextMonitor) return provider;
  return contextMonitor.ts > provider.ts ? contextMonitor : provider;
}

function latestProviderPromptUsage(input: {
  butlerData: string;
  turnId?: string;
}): { promptTokens: number; source: string; ts: number } | null {
  const turnId = input.turnId?.trim();
  if (!turnId) return null;
  let latest: { promptTokens: number; source: string; ts: number } | null = null;
  for (const event of readPromptCacheMetrics({ butlerData: input.butlerData })) {
    if (event.turnId !== turnId) continue;
    if (!Number.isFinite(event.promptTokens) || event.promptTokens <= 0) {
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

function latestContextMonitorPromptUsage(input: {
  butlerData: string;
  runtimeSessionId: string;
}): { promptTokens: number; source: string; ts: number } | null {
  const summary = readContextMonitor({
    butlerData: input.butlerData,
    sessionId: input.runtimeSessionId,
  });
  const latestTurn = summary.latestTurn;
  if (!latestTurn || latestTurn.estimatedTokens <= 0) return null;
  return {
    promptTokens: Math.max(0, Math.round(latestTurn.estimatedTokens)),
    source: "context_monitor",
    ts: latestTurn.ts,
  };
}
