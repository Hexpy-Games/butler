import type {
  HostedProviderApiShape,
  ProviderModelMetadata,
  ReasoningEffort,
} from "../model-catalog.ts";

export const OPENCODE_GO_SOURCE = "https://opencode.ai/docs/go/";
const OPENCODE_GO_PROVIDER_LABEL = "OpenCode Go";

function openCodeGoModel(input: {
  modelId: string;
  displayName: string;
  apiShape: HostedProviderApiShape;
  status?: ProviderModelMetadata["status"];
  defaultReasoningEffort?: ReasoningEffort;
  reasoningEfforts?: ReasoningEffort[];
  runtimeSupported?: boolean;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}): ProviderModelMetadata {
  return {
    provider_id: "opencode-go",
    provider_label: OPENCODE_GO_PROVIDER_LABEL,
    model_id: input.modelId,
    model_ref: `opencode-go/${input.modelId}`,
    display_name: input.displayName,
    status: input.status ?? (input.runtimeSupported === false ? "deprecated" : "available"),
    default_reasoning_effort: input.defaultReasoningEffort ?? "medium",
    reasoning_efforts: input.reasoningEfforts ?? ["none", "low", "medium", "high"],
    token_estimator: "character_estimate",
    source_url: OPENCODE_GO_SOURCE,
    runtime_supported: input.runtimeSupported ?? true,
    hosted_api_shape: input.apiShape,
    ...(input.contextWindowTokens === undefined
      ? {}
      : { context_window_tokens: input.contextWindowTokens }),
    ...(input.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: input.maxOutputTokens }),
  };
}

export const OPENCODE_GO_MODELS: readonly ProviderModelMetadata[] = [
  // OpenAI-compatible Chat Completions carrier.
  openCodeGoModel({ modelId: "grok-4.5", displayName: "Grok 4.5", apiShape: "openai_chat_completions", status: "latest" }),
  openCodeGoModel({ modelId: "glm-5.2", displayName: "GLM-5.2", apiShape: "openai_chat_completions", status: "recommended" }),
  openCodeGoModel({ modelId: "glm-5.1", displayName: "GLM-5.1", apiShape: "openai_chat_completions", status: "available" }),
  openCodeGoModel({ modelId: "kimi-k3", displayName: "Kimi K3", apiShape: "openai_chat_completions", defaultReasoningEffort: "high", reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"] }),
  openCodeGoModel({ modelId: "kimi-k2.7-code", displayName: "Kimi K2.7 Code", apiShape: "openai_chat_completions", defaultReasoningEffort: "high", reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"] }),
  openCodeGoModel({ modelId: "kimi-k2.6", displayName: "Kimi K2.6", apiShape: "openai_chat_completions", defaultReasoningEffort: "high", reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"] }),
  openCodeGoModel({ modelId: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", apiShape: "openai_chat_completions" }),
  openCodeGoModel({ modelId: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", apiShape: "openai_chat_completions" }),
  openCodeGoModel({ modelId: "mimo-v2.5", displayName: "MiMo-V2.5", apiShape: "openai_chat_completions" }),
  openCodeGoModel({ modelId: "mimo-v2.5-pro", displayName: "MiMo-V2.5-Pro", apiShape: "openai_chat_completions" }),
  openCodeGoModel({ modelId: "hy3", displayName: "HY3", apiShape: "openai_chat_completions" }),

  // OpenAI Responses carrier. Runtime registration is gated on the carrier
  // tests, so this model is never silently routed through Chat Completions.
  openCodeGoModel({
    modelId: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    apiShape: "openai_responses",
    status: "available",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
  }),

  // Anthropic Messages-compatible carrier.
  openCodeGoModel({ modelId: "minimax-m3", displayName: "MiniMax M3", apiShape: "anthropic_messages" }),
  openCodeGoModel({ modelId: "minimax-m2.7", displayName: "MiniMax M2.7", apiShape: "anthropic_messages" }),
  openCodeGoModel({ modelId: "qwen3.8-max", displayName: "Qwen3.8 Max", apiShape: "anthropic_messages", defaultReasoningEffort: "high", reasoningEfforts: ["none", "low", "medium", "high", "xhigh"] }),
  openCodeGoModel({ modelId: "qwen3.7-max", displayName: "Qwen3.7 Max", apiShape: "anthropic_messages", defaultReasoningEffort: "high", reasoningEfforts: ["none", "low", "medium", "high", "xhigh"] }),
  openCodeGoModel({ modelId: "qwen3.7-plus", displayName: "Qwen3.7 Plus", apiShape: "anthropic_messages" }),
  openCodeGoModel({ modelId: "qwen3.6-plus", displayName: "Qwen3.6 Plus", apiShape: "anthropic_messages" }),

  // The endpoint documentation mentions this name, but it is absent from
  // the current supported-model list and must remain unadvertised.
  openCodeGoModel({
    modelId: "minimax-m2.5",
    displayName: "MiniMax M2.5 (unsupported)",
    apiShape: "anthropic_messages",
    runtimeSupported: false,
  }),
];
