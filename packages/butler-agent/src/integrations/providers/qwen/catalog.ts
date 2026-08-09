import type { ProviderModelMetadata, ReasoningEffort } from "../model-catalog.ts";

export const QWEN_SOURCE = "https://www.alibabacloud.com/help/en/model-studio/models";
const QWEN_VISION_SOURCE = "https://www.alibabacloud.com/help/en/model-studio/vision-model";
const QWEN_VISION_INPUT = {
  image_input_support: "supported" as const,
  image_capability_source: "provider_catalog" as const,
  image_route_health: "unchecked" as const,
  image_input_modalities: ["text", "image"] as const,
  image_accepted_mime_types: ["image/png", "image/jpeg", "image/webp"] as const,
  image_max_inline_bytes: 7 * 1024 * 1024,
  image_max_width: 7680,
  image_max_height: 4320,
  image_max_pixels: 16_777_216,
  image_capability_source_url: QWEN_VISION_SOURCE,
  image_capability_verified_at: "2026-08-10T00:00:00.000Z",
  image_capability_revision: "qwen-visual-input-v1",
  image_capability_digest: "qwen-visual-input-v1",
  image_endpoint_profile_id: "qwen-openai-chat-vision-v1",
  image_carrier_protocol: "openai_chat_completions" as const,
};
const QWEN_TEXT_ONLY_INPUT = {
  image_input_support: "unsupported" as const,
  image_capability_source: "provider_catalog" as const,
  image_route_health: "unchecked" as const,
  image_input_modalities: ["text"] as const,
  image_capability_source_url: "https://www.alibabacloud.com/help/en/model-studio/qwen3-7-max",
};

const QWEN_REASONING: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh"];

function qwenModel(input: {
  modelId: string;
  displayName: string;
  status: ProviderModelMetadata["status"];
  defaultReasoningEffort: ProviderModelMetadata["default_reasoning_effort"];
  runtimeSupported?: boolean;
  vision?: boolean;
  textOnly?: boolean;
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
    ...(input.vision ? QWEN_VISION_INPUT : {}),
    ...(input.textOnly ? QWEN_TEXT_ONLY_INPUT : {}),
  };
}

export const QWEN_MODELS: readonly ProviderModelMetadata[] = [
  qwenModel({
    modelId: "qwen3.7-max",
    displayName: "Qwen3.7 Max",
    status: "latest",
    defaultReasoningEffort: "high",
    textOnly: true,
  }),
  qwenModel({
    modelId: "qwen3.7-plus",
    displayName: "Qwen3.7 Plus",
    status: "recommended",
    defaultReasoningEffort: "medium",
    vision: true,
  }),
  qwenModel({
    modelId: "qwen3.6-flash",
    displayName: "Qwen3.6 Flash",
    status: "available",
    defaultReasoningEffort: "medium",
    vision: true,
  }),
  qwenModel({
    modelId: "qwen3.6-plus",
    displayName: "Qwen3.6 Plus (retired)",
    status: "deprecated",
    defaultReasoningEffort: "medium",
    runtimeSupported: false,
  }),
];
