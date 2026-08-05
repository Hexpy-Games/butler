import type { ProviderModelMetadata, ReasoningEffort } from "../model-catalog.ts";

export const KIMI_SOURCE = "https://platform.kimi.ai/docs/models";

const KIMI_REASONING: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];

function kimiModel(input: {
  modelId: string;
  displayName: string;
  status: ProviderModelMetadata["status"];
  contextWindowTokens: number;
  defaultReasoningEffort: ProviderModelMetadata["default_reasoning_effort"];
  runtimeSupported?: boolean;
}): ProviderModelMetadata {
  return {
    provider_id: "kimi",
    provider_label: "Moonshot / Kimi",
    model_id: input.modelId,
    model_ref: `kimi/${input.modelId}`,
    display_name: input.displayName,
    status: input.status,
    context_window_tokens: input.contextWindowTokens,
    default_reasoning_effort: input.defaultReasoningEffort,
    reasoning_efforts: KIMI_REASONING,
    token_estimator: "character_estimate",
    source_url: KIMI_SOURCE,
    runtime_supported: input.runtimeSupported ?? true,
    hosted_api_shape: "openai_chat_completions",
  };
}

export const KIMI_MODELS: readonly ProviderModelMetadata[] = [
  kimiModel({
    modelId: "kimi-k3",
    displayName: "Kimi K3",
    status: "latest",
    contextWindowTokens: 1_000_000,
    defaultReasoningEffort: "high",
  }),
  kimiModel({
    modelId: "kimi-k2.7-code",
    displayName: "Kimi K2.7 Code",
    status: "recommended",
    contextWindowTokens: 256_000,
    defaultReasoningEffort: "high",
  }),
  kimiModel({
    modelId: "kimi-k2.6",
    displayName: "Kimi K2.6",
    status: "available",
    contextWindowTokens: 256_000,
    defaultReasoningEffort: "high",
  }),
  // Official throughput variant intentionally cannot be selected as a
  // second registration for the same provider/model family.
  kimiModel({
    modelId: "kimi-k2.7-code-highspeed",
    displayName: "Kimi K2.7 Code Highspeed (unsupported)",
    status: "deprecated",
    contextWindowTokens: 256_000,
    defaultReasoningEffort: "high",
    runtimeSupported: false,
  }),
  kimiModel({
    modelId: "kimi-k2.5",
    displayName: "Kimi K2.5 (retired)",
    status: "deprecated",
    contextWindowTokens: 256_000,
    defaultReasoningEffort: "high",
    runtimeSupported: false,
  }),
];
