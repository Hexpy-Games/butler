import type { ProviderModelMetadata, ReasoningEffort } from "../model-catalog.ts";

export const QWEN_SOURCE = "https://www.alibabacloud.com/help/en/model-studio/models";

const QWEN_REASONING: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh"];

function qwenModel(input: {
  modelId: string;
  displayName: string;
  status: ProviderModelMetadata["status"];
  defaultReasoningEffort: ProviderModelMetadata["default_reasoning_effort"];
  runtimeSupported?: boolean;
}): ProviderModelMetadata {
  return {
    provider_id: "qwen",
    provider_label: "Qwen Cloud",
    model_id: input.modelId,
    model_ref: `qwen/${input.modelId}`,
    display_name: input.displayName,
    status: input.status,
    context_window_tokens: 1_048_576,
    default_reasoning_effort: input.defaultReasoningEffort,
    reasoning_efforts: QWEN_REASONING,
    token_estimator: "character_estimate",
    source_url: QWEN_SOURCE,
    runtime_supported: input.runtimeSupported ?? true,
    hosted_api_shape: "openai_chat_completions",
  };
}

export const QWEN_MODELS: readonly ProviderModelMetadata[] = [
  qwenModel({
    modelId: "qwen3.7-max",
    displayName: "Qwen3.7 Max",
    status: "latest",
    defaultReasoningEffort: "high",
  }),
  qwenModel({
    modelId: "qwen3.7-plus",
    displayName: "Qwen3.7 Plus",
    status: "recommended",
    defaultReasoningEffort: "medium",
  }),
  qwenModel({
    modelId: "qwen3.6-flash",
    displayName: "Qwen3.6 Flash",
    status: "available",
    defaultReasoningEffort: "medium",
  }),
  qwenModel({
    modelId: "qwen3.6-plus",
    displayName: "Qwen3.6 Plus (retired)",
    status: "deprecated",
    defaultReasoningEffort: "medium",
    runtimeSupported: false,
  }),
];
