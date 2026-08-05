import type { ProviderModelMetadata } from "../model-catalog.ts";

export const XAI_SOURCE = "https://docs.x.ai/developers/models";

function xaiModel(
  modelId: string,
  displayName: string,
  runtimeSupported: boolean,
): ProviderModelMetadata {
  return {
    provider_id: "xai",
    provider_label: "xAI / Grok",
    model_id: modelId,
    model_ref: `xai/${modelId}`,
    display_name: displayName,
    status: runtimeSupported ? "latest" : "deprecated",
    context_window_tokens: 500_000,
    default_reasoning_effort: "medium",
    reasoning_efforts: ["none", "low", "medium", "high", "xhigh"],
    token_estimator: "character_estimate",
    source_url: XAI_SOURCE,
    runtime_supported: runtimeSupported,
    hosted_api_shape: "openai_responses",
  };
}

export const XAI_MODELS: readonly ProviderModelMetadata[] = [
  xaiModel("grok-4.5", "Grok 4.5", true),
  xaiModel("grok-4.3", "Grok 4.3 (retired)", false),
  xaiModel("grok-4.20-multi-agent", "Grok 4.20 Multi-Agent (retired)", false),
];
