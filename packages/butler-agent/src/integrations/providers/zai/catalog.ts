import type { ProviderModelMetadata, ReasoningEffort } from "../model-catalog.ts";

export const ZAI_SOURCE = "https://docs.z.ai/guides/overview/quick-start";
const ZAI_VISION_MCP_IMAGE = {
  // Capability is advertised only after the enabled `zai-vision` MCP server
  // proves this exact tool schema at admission.  The base catalog is
  // documentation-only and therefore remains fail-closed.
  image_input_verified: false,
  image_input_modalities: ["text", "image"] as const,
  image_accepted_mime_types: ["image/png", "image/jpeg", "image/webp"] as const,
  image_max_inline_bytes: 10 * 1024 * 1024,
  image_max_width: 4096,
  image_max_height: 4096,
  image_max_pixels: 16_000_000,
  image_capability_source_url: "https://www.npmjs.com/package/@z_ai/mcp-server",
  image_capability_verified_at: "2026-08-09T00:00:00.000Z",
  image_capability_revision: "zai-vision-mcp-0.1.4",
  image_capability_digest: "zai-vision-mcp-unprobed",
  image_endpoint_profile_id: "zai-vision-mcp-0.1.4",
  image_carrier_protocol: "zai_mcp_vision" as const,
  image_tool_server_id: "zai-vision",
  image_tool_name: "analyze_image",
};

const ZAI_REASONING: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];

function zaiModel(input: {
  modelId: string;
  displayName: string;
  status: ProviderModelMetadata["status"];
  contextWindowTokens: number;
  defaultReasoningEffort: ProviderModelMetadata["default_reasoning_effort"];
  runtimeSupported?: boolean;
  toolAssistedVision?: boolean;
}): ProviderModelMetadata {
  return {
    provider_id: "zai",
    provider_label: "Z.AI Coding Plan",
    provider_family_id: "zai",
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
    ...(input.toolAssistedVision ? ZAI_VISION_MCP_IMAGE : {}),
  };
}

export const ZAI_MODELS: readonly ProviderModelMetadata[] = [
  zaiModel({
    modelId: "glm-5.2",
    displayName: "GLM-5.2",
    status: "latest",
    contextWindowTokens: 1_000_000,
    defaultReasoningEffort: "high",
    toolAssistedVision: true,
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
