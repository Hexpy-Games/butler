import type { ProviderModelMetadata } from "../model-catalog.ts";

export const GEMINI_SOURCE = "https://ai.google.dev/gemini-api/docs/models";

function googleModel(input: {
  modelId: string;
  displayName: string;
  status: ProviderModelMetadata["status"];
  defaultReasoningEffort: ProviderModelMetadata["default_reasoning_effort"];
  reasoningEfforts: ProviderModelMetadata["reasoning_efforts"];
  runtimeSupported?: boolean;
}): ProviderModelMetadata {
  return {
    provider_id: "google",
    provider_label: "Google",
    model_id: input.modelId,
    model_ref: `google/${input.modelId}`,
    display_name: input.displayName,
    status: input.status,
    context_window_tokens: 1_048_576,
    max_output_tokens: 65_536,
    default_reasoning_effort: input.defaultReasoningEffort,
    reasoning_efforts: input.reasoningEfforts,
    token_estimator: "gemini_count_tokens_api",
    source_url: GEMINI_SOURCE,
    runtime_supported: input.runtimeSupported ?? true,
    hosted_api_shape: "gemini_generate_content",
  };
}

export const GOOGLE_MODELS: readonly ProviderModelMetadata[] = [
  googleModel({
    modelId: "gemini-3.6-flash",
    displayName: "Gemini 3.6 Flash",
    status: "latest",
    defaultReasoningEffort: "medium",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
  }),
  googleModel({
    modelId: "gemini-3.5-flash",
    displayName: "Gemini 3.5 Flash",
    status: "recommended",
    defaultReasoningEffort: "medium",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
  }),
  googleModel({
    modelId: "gemini-3.5-flash-lite",
    displayName: "Gemini 3.5 Flash-Lite",
    status: "available",
    defaultReasoningEffort: "low",
    reasoningEfforts: ["none", "low", "medium", "high"],
  }),
  googleModel({
    modelId: "gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro Preview",
    status: "available",
    defaultReasoningEffort: "high",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
  }),
  googleModel({
    modelId: "gemini-3.1-pro",
    displayName: "Gemini 3.1 Pro (retired)",
    status: "deprecated",
    defaultReasoningEffort: "high",
    reasoningEfforts: ["none", "low", "medium", "high"],
    runtimeSupported: false,
  }),
];
