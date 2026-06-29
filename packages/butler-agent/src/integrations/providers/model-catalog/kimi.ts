import type { ProviderModelMetadata } from "../model-catalog.ts";

const KIMI_SOURCE = "https://platform.kimi.ai/docs/models";

export const KIMI_MODELS: readonly ProviderModelMetadata[] = [
  {
    provider_id: "kimi",
    provider_label: "Moonshot / Kimi",
    model_id: "kimi-k2.6",
    model_ref: "kimi/kimi-k2.6",
    display_name: "Kimi K2.6",
    status: "latest",
    context_window_tokens: 256_000,
    max_output_tokens: 96_000,
    default_reasoning_effort: "high",
    reasoning_efforts: ["none", "high"],
    token_estimator: "character_estimate",
    source_url: KIMI_SOURCE,
    runtime_supported: true,
  },
  {
    provider_id: "kimi",
    provider_label: "Moonshot / Kimi",
    model_id: "kimi-k2.5",
    model_ref: "kimi/kimi-k2.5",
    display_name: "Kimi K2.5",
    status: "recommended",
    context_window_tokens: 256_000,
    max_output_tokens: 96_000,
    default_reasoning_effort: "high",
    reasoning_efforts: ["none", "high"],
    token_estimator: "character_estimate",
    source_url: KIMI_SOURCE,
    runtime_supported: true,
  },
];
