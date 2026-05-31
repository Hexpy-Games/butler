import type { AppModelSummary } from "@/app/types.ts";

export function clampedPercent(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

export function percentToRatio(value: string): number {
  return clampedPercent(value) / 100;
}

export function ratioToPercent(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return "0";
  return String(Math.round(Math.max(0, Math.min(1, value)) * 100));
}

export function localModelMutationPayload(
  model: AppModelSummary,
  reasoningBudgetRatio: number,
) {
  return {
    provider_id: "local",
    api_type: model.api_type ?? "openai_compatible",
    platform: model.platform ?? "custom",
    server_url: model.server_url ?? "",
    model_id: model.model_id,
    display_name: model.display_name,
    context_window_tokens: model.context_window_tokens,
    max_output_tokens: model.max_output_tokens,
    reasoning_budget_ratio: reasoningBudgetRatio,
    source: model.source ?? "manual",
  };
}