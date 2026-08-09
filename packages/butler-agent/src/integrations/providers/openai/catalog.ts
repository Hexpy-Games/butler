import type { ProviderModelMetadata, ReasoningEffort } from "../model-catalog.ts";
import { AUTO_CODEX_LATEST } from "./models.ts";

export const OPENAI_SOURCE = "https://developers.openai.com/api/docs/models/compare";
const OPENAI_IMAGE_INPUT = {
  // Documentation describes the model-family capability, but a carrier is
  // not production-advertised until the exact registered credential/base URL
  // has passed the bounded synthetic-image probe.  The registered-model
  // overlay sets this to true only for that exact persisted route evidence.
  image_input_verified: false,
  image_input_modalities: ["text", "image"] as const,
  image_accepted_mime_types: ["image/png", "image/jpeg", "image/webp"] as const,
  image_max_inline_bytes: 10 * 1024 * 1024,
  image_max_width: 4096,
  image_max_height: 4096,
  image_max_pixels: 16_000_000,
  image_capability_source_url: "https://developers.openai.com/api/docs/models",
  image_capability_verified_at: "2026-08-09T00:00:00.000Z",
  image_capability_revision: "openai-image-input-v1",
  image_capability_digest: "75bd5b41fd9ad7888fde02bc82c785c57e7245c55f892378b133e5bea51f4de7",
  image_endpoint_profile_id: "openai-responses-v1",
  image_carrier_protocol: "openai_responses" as const,
};

const DEFAULT_REASONING_EFFORT: ReasoningEffort = "xhigh";
const GPT_56_REASONING_EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];
const GPT_55_REASONING_EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh"];

export const OPENAI_MODELS: readonly ProviderModelMetadata[] = [
  {
    provider_id: "openai",
    provider_label: "OpenAI",
    model_id: "gpt-5.6-sol",
    model_ref: "openai/gpt-5.6-sol",
    // `auto:codex-latest` is a declared dynamic Codex carrier, not a
    // user-entered unknown model. Keep it tied to the catalog's current
    // Codex entry while preserving strict handling for all other missing refs.
    aliases: [AUTO_CODEX_LATEST, `openai/${AUTO_CODEX_LATEST}`],
    display_name: "GPT-5.6 Sol",
    status: "latest",
    context_window_tokens: 1_050_000,
    max_output_tokens: 128_000,
    default_reasoning_effort: DEFAULT_REASONING_EFFORT,
    reasoning_efforts: GPT_56_REASONING_EFFORTS,
    token_estimator: "openai_tiktoken_o200k",
    source_url: OPENAI_SOURCE,
    runtime_supported: true,
    ...OPENAI_IMAGE_INPUT,
  },
  {
    provider_id: "openai",
    provider_label: "OpenAI",
    model_id: "gpt-5.6-terra",
    model_ref: "openai/gpt-5.6-terra",
    display_name: "GPT-5.6 Terra",
    status: "recommended",
    context_window_tokens: 1_050_000,
    max_output_tokens: 128_000,
    default_reasoning_effort: "medium",
    reasoning_efforts: GPT_56_REASONING_EFFORTS,
    token_estimator: "openai_tiktoken_o200k",
    source_url: OPENAI_SOURCE,
    runtime_supported: true,
    ...OPENAI_IMAGE_INPUT,
  },
  {
    provider_id: "openai",
    provider_label: "OpenAI",
    model_id: "gpt-5.6-luna",
    model_ref: "openai/gpt-5.6-luna",
    display_name: "GPT-5.6 Luna",
    status: "available",
    context_window_tokens: 1_050_000,
    max_output_tokens: 128_000,
    default_reasoning_effort: "medium",
    reasoning_efforts: GPT_56_REASONING_EFFORTS,
    token_estimator: "openai_tiktoken_o200k",
    source_url: OPENAI_SOURCE,
    runtime_supported: true,
    ...OPENAI_IMAGE_INPUT,
  },
  {
    provider_id: "openai",
    provider_label: "OpenAI",
    model_id: "gpt-5.5",
    model_ref: "openai/gpt-5.5",
    // The Codex subscription carrier historically persisted this alias. Keep
    // it explicit so old settings remain identifiable without selecting a
    // newer OpenAI model by accident.
    aliases: ["gpt-5.5", "gpt-5.5-codex", "openai/gpt-5.5-codex"],
    display_name: "GPT-5.5",
    status: "available",
    context_window_tokens: 1_050_000,
    max_output_tokens: 128_000,
    default_reasoning_effort: DEFAULT_REASONING_EFFORT,
    reasoning_efforts: GPT_55_REASONING_EFFORTS,
    token_estimator: "openai_tiktoken_o200k",
    source_url: OPENAI_SOURCE,
    runtime_supported: true,
    ...OPENAI_IMAGE_INPUT,
  },
  {
    provider_id: "openai",
    provider_label: "OpenAI",
    model_id: "gpt-5.4",
    model_ref: "openai/gpt-5.4",
    display_name: "GPT-5.4",
    status: "available",
    context_window_tokens: 1_050_000,
    max_output_tokens: 128_000,
    default_reasoning_effort: "medium",
    reasoning_efforts: GPT_55_REASONING_EFFORTS,
    token_estimator: "openai_tiktoken_o200k",
    source_url: OPENAI_SOURCE,
    runtime_supported: true,
    ...OPENAI_IMAGE_INPUT,
  },
  {
    provider_id: "openai",
    provider_label: "OpenAI",
    model_id: "gpt-5.4-mini",
    model_ref: "openai/gpt-5.4-mini",
    display_name: "GPT-5.4 Mini",
    status: "available",
    context_window_tokens: 400_000,
    max_output_tokens: 128_000,
    default_reasoning_effort: "medium",
    reasoning_efforts: GPT_55_REASONING_EFFORTS,
    token_estimator: "openai_tiktoken_o200k",
    source_url: OPENAI_SOURCE,
    runtime_supported: true,
    ...OPENAI_IMAGE_INPUT,
  },
  {
    provider_id: "openai",
    provider_label: "OpenAI",
    model_id: "gpt-5.4-nano",
    model_ref: "openai/gpt-5.4-nano",
    display_name: "GPT-5.4 Nano",
    status: "available",
    context_window_tokens: 400_000,
    max_output_tokens: 128_000,
    default_reasoning_effort: "medium",
    reasoning_efforts: GPT_55_REASONING_EFFORTS,
    token_estimator: "openai_tiktoken_o200k",
    source_url: OPENAI_SOURCE,
    runtime_supported: true,
    ...OPENAI_IMAGE_INPUT,
  },
];
