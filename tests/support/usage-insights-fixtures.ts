import type { ModelCatalogView, UsageHistoryView, UsageMonitorView } from "../../packages/butler-app/client/ui/src/app/types";
import { HARNESS_MODEL_CATALOG, HARNESS_PRIMARY_MODEL } from "../../packages/butler-app/client/ui/src/app/fixtures";
import { quota, usageView } from "../../packages/butler-app/client/ui/src/components/conversation/contextUsage.fixtures";

export const INSIGHTS_NOW = new Date("2026-09-16T05:10:00Z");
export const INSIGHTS_PROVIDERS = ["zai", "anthropic", "google", "openai"];

export function insightsCatalog(): ModelCatalogView {
  const models = INSIGHTS_PROVIDERS.map(provider_id => ({ ...HARNESS_PRIMARY_MODEL, provider_id,
    provider_label: ({ zai: "Z.AI", openai: "OpenAI", anthropic: "Anthropic", google: "Google" } as Record<string, string>)[provider_id]!,
    model_ref: provider_id === "openai" ? HARNESS_PRIMARY_MODEL.model_ref : `${provider_id}/model`, model_id: "model", auth_type: "api_key" as const }));
  return { ...HARNESS_MODEL_CATALOG, models: [...models].reverse(), registered_models: models,
    providers: models.map(model => ({ ...HARNESS_MODEL_CATALOG.providers[0]!,
      provider_id: model.provider_id, provider_label: model.provider_label, models: [model] })) };
}

export function historyFixture(empty = false): UsageHistoryView {
  const today = Date.parse("2026-09-16T00:00:00Z");
  const days: [string, number][] = Array.from({ length: 371 }, (_, i) => [new Date(today - (370 - i) * 86400000).toISOString().slice(0, 10),
    empty || i % 7 === 0 ? 0 : i === 368 ? 300000000 : (i % 13 + 1) * 1000000]);
  return { lifetimeTokens: empty ? 0 : 4410000000,
    busiestDay: empty ? null : { date: "2026-09-14", tokens: 300000000 },
    longestTask: empty ? null : { durationMs: 24060000, sessionId: "s1", title: "Rewrite the release notes for preview 14" },
    longestStreak: { days: empty ? 0 : 41, start: empty ? null : "2026-08-02", end: empty ? null : "2026-09-11" },
    currentStreak: { days: empty ? 0 : 23, start: empty ? null : "2026-08-25" }, days,
    priorTotal: empty ? 0 : 4410000000 - days.reduce((sum, [, value]) => sum + value, 0),
    firstActiveDate: empty ? null : "2025-01-01", timeZone: "Asia/Seoul" };
}

export function insightsMonitor(noProviders = false, empty = false): UsageMonitorView {
  const view = usageView();
  view.filters.sessionId = null;
  view.generated_at = INSIGHTS_NOW.toISOString();
  view.filters.sinceTs = +INSIGHTS_NOW - 86400000;
  view.filters.untilTs = +INSIGHTS_NOW;
  view.timeline.slots = empty ? [] : [[+INSIGHTS_NOW - 900000, 3, 48200, 31900, 3420]];
  view.topSessions = empty ? [] : [{ sessionId: "s1", title: "Rewrite the release notes", kind: "chat", totalTokens: 51620, requests: 3, lastUsedMs: +INSIGHTS_NOW }];
  if (empty) view.model = { ...view.model, totalTokens: 0, requestCount: 0, promptTokens: 0, outputTokens: 0, cachedTokens: 0, uncachedTokens: 0 };
  const template = view.providerUsage.providers[0]!;
  const fetchedAt = new Date(+INSIGHTS_NOW - 12 * 60000).toISOString();
  const resetsAt = new Date(+INSIGHTS_NOW + 72 * 60000).toISOString();
  // Deliberately reverse catalog order: presentation must follow the settings models.
  view.providerUsage.providers = noProviders ? [] : [...INSIGHTS_PROVIDERS].reverse().map(providerId => {
    const windows = providerId === "zai"
      ? [["tokens-5-hour", 82, 300], ["tokens-weekly", 20, 10080], ["mcp-month", 64, 43200]] as const
      : providerId === "openai" ? [["primary", 0, 300], ["secondary", 75, 10080]] as const
        : providerId === "google" ? [["requests-day", 60, 1440]] as const : [];
    return { ...template, providerId, monthTokens: providerId === "anthropic" ? 12400000 : 51620,
      remaining: quota({ sourceKind: providerId === "openai" ? "chatgpt_plan" : "provider_quota", fetchedAt,
        planName: providerId === "zai" ? "Coding Plan" : providerId === "openai" ? "Plus" : null,
        available: providerId !== "anthropic" && providerId !== "google", stale: providerId === "google", planUsage: null,
        planKind: providerId === "anthropic" || providerId === "google" ? "api" : "subscription",
        reason: providerId === "anthropic" ? { code: "provider_quota_not_offered", message: "" }
          : providerId === "google" ? { code: "provider_quota_fetch_failed", message: "" } : null,
        windows: windows.map(([id, remainingPercent, windowDurationMins]) => ({ id, remainingPercent,
          usedPercent: 100 - remainingPercent, windowDurationMins, resetsAt, expiresAt: null })) }) };
  });
  return view;
}
