import type { ProviderModelMetadata, ReasoningEffort } from "../model-catalog.ts";

export const ZAI_SOURCE = "https://docs.z.ai/guides/overview/quick-start";

const ZAI_REASONING: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];

function zaiModel(input: {
  modelId: string;
  displayName: string;
  status: ProviderModelMetadata["status"];
  contextWindowTokens: number;
  defaultReasoningEffort: ProviderModelMetadata["default_reasoning_effort"];
  runtimeSupported?: boolean;
}): ProviderModelMetadata {
  return {
    provider_id: "zai",
    provider_label: "Z.AI / GLM",
    model_id: input.modelId,
    model_ref: `zai/${input.modelId}`,
    display_name: input.displayName,
    status: input.status,
    context_window_tokens: input.contextWindowTokens,
    max_output_tokens: 128_000,
    default_reasoning_effort: input.defaultReasoningEffort,
    reasoning_efforts: ZAI_REASONING,
    token_estimator: "character_estimate",
    source_url: ZAI_SOURCE,
    runtime_supported: input.runtimeSupported ?? true,
    hosted_api_shape: "openai_chat_completions",
  };
}

export const ZAI_MODELS: readonly ProviderModelMetadata[] = [
  zaiModel({
    modelId: "glm-5.2",
    displayName: "GLM-5.2",
    status: "latest",
    contextWindowTokens: 1_000_000,
    defaultReasoningEffort: "high",
  }),
  zaiModel({
    modelId: "glm-5.1",
    displayName: "GLM-5.1",
    status: "recommended",
    contextWindowTokens: 200_000,
    defaultReasoningEffort: "high",
  }),
  zaiModel({
    modelId: "glm-5",
    displayName: "GLM-5",
    status: "available",
    contextWindowTokens: 200_000,
    defaultReasoningEffort: "medium",
  }),
  zaiModel({
    modelId: "glm-4.7",
    displayName: "GLM-4.7 (retired)",
    status: "deprecated",
    contextWindowTokens: 200_000,
    defaultReasoningEffort: "medium",
    runtimeSupported: false,
  }),
];
