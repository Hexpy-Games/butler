import type { ProviderModelMetadata, ReasoningEffort } from "../model-catalog.ts";

export const ANTHROPIC_SOURCE = "https://platform.claude.com/docs/en/about-claude/models/overview";

const CLAUDE_5_REASONING: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];
const HAIKU_REASONING: ReasoningEffort[] = ["none", "low", "medium", "high"];

function retiredAnthropicModel(
  modelId: string,
  displayName: string,
  contextWindowTokens: number,
  maxOutputTokens: number,
): ProviderModelMetadata {
  return {
    provider_id: "anthropic",
    provider_label: "Anthropic",
    model_id: modelId,
    model_ref: `anthropic/${modelId}`,
    display_name: displayName,
    status: "deprecated",
    context_window_tokens: contextWindowTokens,
    max_output_tokens: maxOutputTokens,
    default_reasoning_effort: "medium",
    reasoning_efforts: ["none", "low", "medium", "high"],
    token_estimator: "anthropic_count_tokens_api",
    source_url: ANTHROPIC_SOURCE,
    runtime_supported: false,
    hosted_api_shape: "anthropic_messages",
  };
}

export const ANTHROPIC_MODELS: readonly ProviderModelMetadata[] = [
  {
    provider_id: "anthropic",
    provider_label: "Anthropic",
    model_id: "claude-fable-5",
    model_ref: "anthropic/claude-fable-5",
    display_name: "Claude Fable 5",
    status: "latest",
    context_window_tokens: 1_000_000,
    max_output_tokens: 128_000,
    default_reasoning_effort: "high",
    reasoning_efforts: CLAUDE_5_REASONING,
    token_estimator: "anthropic_count_tokens_api",
    source_url: ANTHROPIC_SOURCE,
    runtime_supported: true,
    hosted_api_shape: "anthropic_messages",
  },
  {
    provider_id: "anthropic",
    provider_label: "Anthropic",
    model_id: "claude-opus-5",
    model_ref: "anthropic/claude-opus-5",
    display_name: "Claude Opus 5",
    status: "recommended",
    context_window_tokens: 1_000_000,
    max_output_tokens: 128_000,
    default_reasoning_effort: "high",
    reasoning_efforts: CLAUDE_5_REASONING,
    token_estimator: "anthropic_count_tokens_api",
    source_url: ANTHROPIC_SOURCE,
    runtime_supported: true,
    hosted_api_shape: "anthropic_messages",
  },
  {
    provider_id: "anthropic",
    provider_label: "Anthropic",
    model_id: "claude-sonnet-5",
    model_ref: "anthropic/claude-sonnet-5",
    display_name: "Claude Sonnet 5",
    status: "available",
    context_window_tokens: 1_000_000,
    max_output_tokens: 128_000,
    default_reasoning_effort: "medium",
    reasoning_efforts: CLAUDE_5_REASONING,
    token_estimator: "anthropic_count_tokens_api",
    source_url: ANTHROPIC_SOURCE,
    runtime_supported: true,
    hosted_api_shape: "anthropic_messages",
  },
  {
    provider_id: "anthropic",
    provider_label: "Anthropic",
    model_id: "claude-haiku-4-5",
    model_ref: "anthropic/claude-haiku-4-5",
    display_name: "Claude Haiku 4.5",
    status: "available",
    context_window_tokens: 200_000,
    max_output_tokens: 64_000,
    default_reasoning_effort: "low",
    reasoning_efforts: HAIKU_REASONING,
    token_estimator: "anthropic_count_tokens_api",
    source_url: ANTHROPIC_SOURCE,
    runtime_supported: true,
    hosted_api_shape: "anthropic_messages",
  },
  // Retained only to make a previously persisted ref fail as unavailable;
  // the runtime and Settings selectors filter runtime_supported=false.
  retiredAnthropicModel("claude-opus-4-7", "Claude Opus 4.7 (retired)", 1_000_000, 128_000),
  retiredAnthropicModel("claude-sonnet-4-6", "Claude Sonnet 4.6 (retired)", 1_000_000, 64_000),
];
