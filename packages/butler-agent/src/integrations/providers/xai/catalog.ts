import type { ProviderModelMetadata } from "../model-catalog.ts";

const XAI_SOURCE = "https://docs.x.ai/developers/models";

export const XAI_MODELS: readonly ProviderModelMetadata[] = [
  {
    provider_id: "xai",
    provider_label: "xAI / Grok",
    model_id: "grok-4.3",
    model_ref: "xai/grok-4.3",
    display_name: "Grok 4.3",
    status: "latest",
    context_window_tokens: 1_000_000,
    max_output_tokens: 128_000,
    default_reasoning_effort: "low",
    reasoning_efforts: ["none", "low", "medium", "high"],
    token_estimator: "character_estimate",
    source_url: XAI_SOURCE,
    runtime_supported: true,
  },
  {
    provider_id: "xai",
    provider_label: "xAI / Grok",
    model_id: "grok-4.20-multi-agent",
    model_ref: "xai/grok-4.20-multi-agent",
    display_name: "Grok 4.20 Multi-Agent",
    status: "available",
    context_window_tokens: 2_000_000,
    max_output_tokens: 128_000,
    default_reasoning_effort: "medium",
    reasoning_efforts: ["low", "medium", "high", "xhigh"],
    token_estimator: "character_estimate",
    source_url: XAI_SOURCE,
    runtime_supported: true,
  },
];
