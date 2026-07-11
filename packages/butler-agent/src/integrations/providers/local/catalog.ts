import type { LocalModelConfig } from "./models.ts";
import type { ProviderModelMetadata, ReasoningEffort } from "../model-catalog.ts";

export function localModelConfigToMetadata(model: LocalModelConfig): ProviderModelMetadata {
  const reasoningBudgetTokens = localReasoningBudgetTokens(model);
  const reasoningEfforts: ReasoningEffort[] = reasoningBudgetTokens
    ? ["none", "high"]
    : ["none"];
  return {
    provider_id: "local",
    provider_label: model.provider_label,
    model_id: model.model_id,
    model_ref: model.model_ref,
    display_name: model.display_name,
    status: "available",
    context_window_tokens: model.context_window_tokens,
    max_output_tokens: model.max_output_tokens,
    default_reasoning_effort: reasoningBudgetTokens ? "high" : "none",
    reasoning_efforts: reasoningEfforts,
    ...(reasoningBudgetTokens
      ? {
        reasoning_budget_tokens: {
          high: reasoningBudgetTokens,
        },
      }
      : {}),
    token_estimator: model.token_estimator,
    source_url: model.source_url,
    runtime_supported: true,
    api_type: model.api_type,
    platform: model.platform,
    server_url: model.server_url,
    source: model.source,
    local_reasoning_budget_ratio: model.reasoning_budget_ratio,
  };
}

function localReasoningBudgetTokens(model: LocalModelConfig): number | null {
  const ratio = model.reasoning_budget_ratio;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0) return null;
  const maxOutputTokens = Number.isFinite(model.max_output_tokens)
    ? Math.trunc(model.max_output_tokens)
    : 0;
  if (maxOutputTokens <= 0) return null;
  const budget = Math.round(maxOutputTokens * Math.min(1, ratio));
  return budget > 0 ? budget : null;
}
