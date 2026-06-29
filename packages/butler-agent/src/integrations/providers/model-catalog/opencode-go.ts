import type { HostedProviderApiShape, ProviderModelMetadata, ReasoningEffort } from "../model-catalog.ts";

const OPENCODE_GO_SOURCE = "https://opencode.ai/docs/go/";
const OPENCODE_GO_PROVIDER_LABEL = "OpenCode Go";
const OPENCODE_GO_DEFAULT_CONTEXT_WINDOW = 200_000;
const OPENCODE_GO_DEFAULT_MAX_OUTPUT = 64_000;

function openCodeGoModel(input: {
  modelId: string;
  displayName: string;
  status?: ProviderModelMetadata["status"];
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  defaultReasoningEffort?: ReasoningEffort;
  reasoningEfforts?: ReasoningEffort[];
  apiShape: HostedProviderApiShape;
}): ProviderModelMetadata {
  return {
    provider_id: "opencode-go",
    provider_label: OPENCODE_GO_PROVIDER_LABEL,
    model_id: input.modelId,
    model_ref: `opencode-go/${input.modelId}`,
    display_name: input.displayName,
    status: input.status ?? "available",
    context_window_tokens: input.contextWindowTokens ?? OPENCODE_GO_DEFAULT_CONTEXT_WINDOW,
    max_output_tokens: input.maxOutputTokens ?? OPENCODE_GO_DEFAULT_MAX_OUTPUT,
    default_reasoning_effort: input.defaultReasoningEffort ?? "medium",
    reasoning_efforts: input.reasoningEfforts ?? ["none", "low", "medium", "high"],
    token_estimator: "character_estimate",
    source_url: OPENCODE_GO_SOURCE,
    runtime_supported: true,
    hosted_api_shape: input.apiShape,
  };
}

export const OPENCODE_GO_MODELS: readonly ProviderModelMetadata[] = [
  openCodeGoModel({
    modelId: "glm-5.2",
    displayName: "GLM-5.2",
    status: "latest",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    defaultReasoningEffort: "high",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    apiShape: "openai_chat_completions",
  }),
  openCodeGoModel({
    modelId: "glm-5.1",
    displayName: "GLM-5.1",
    status: "recommended",
    defaultReasoningEffort: "high",
    apiShape: "openai_chat_completions",
  }),
  openCodeGoModel({
    modelId: "kimi-k2.7-code",
    displayName: "Kimi K2.7 Code",
    status: "recommended",
    contextWindowTokens: 256_000,
    maxOutputTokens: 96_000,
    defaultReasoningEffort: "high",
    reasoningEfforts: ["none", "high"],
    apiShape: "openai_chat_completions",
  }),
  openCodeGoModel({
    modelId: "kimi-k2.6",
    displayName: "Kimi K2.6",
    contextWindowTokens: 256_000,
    maxOutputTokens: 96_000,
    defaultReasoningEffort: "high",
    reasoningEfforts: ["none", "high"],
    apiShape: "openai_chat_completions",
  }),
  openCodeGoModel({
    modelId: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    apiShape: "openai_chat_completions",
  }),
  openCodeGoModel({
    modelId: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    apiShape: "openai_chat_completions",
  }),
  openCodeGoModel({
    modelId: "mimo-v2.5",
    displayName: "MiMo-V2.5",
    apiShape: "openai_chat_completions",
  }),
  openCodeGoModel({
    modelId: "mimo-v2.5-pro",
    displayName: "MiMo-V2.5-Pro",
    apiShape: "openai_chat_completions",
  }),
  openCodeGoModel({
    modelId: "minimax-m3",
    displayName: "MiniMax M3",
    apiShape: "anthropic_messages",
  }),
  openCodeGoModel({
    modelId: "minimax-m2.7",
    displayName: "MiniMax M2.7",
    apiShape: "anthropic_messages",
  }),
  openCodeGoModel({
    modelId: "minimax-m2.5",
    displayName: "MiniMax M2.5",
    apiShape: "anthropic_messages",
  }),
  openCodeGoModel({
    modelId: "qwen3.7-max",
    displayName: "Qwen3.7 Max",
    contextWindowTokens: 1_048_576,
    defaultReasoningEffort: "high",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    apiShape: "anthropic_messages",
  }),
  openCodeGoModel({
    modelId: "qwen3.7-plus",
    displayName: "Qwen3.7 Plus",
    contextWindowTokens: 1_048_576,
    defaultReasoningEffort: "medium",
    apiShape: "anthropic_messages",
  }),
  openCodeGoModel({
    modelId: "qwen3.6-plus",
    displayName: "Qwen3.6 Plus",
    contextWindowTokens: 1_048_576,
    defaultReasoningEffort: "medium",
    apiShape: "anthropic_messages",
  }),
];
