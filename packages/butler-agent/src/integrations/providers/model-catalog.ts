import { getEncoding, type Tiktoken } from "js-tiktoken";
import { readLocalModelConfigs, type LocalModelApiType, type LocalModelConfig, type LocalModelPlatform, type LocalModelSource } from "./local-models.ts";
import { parseModelRef } from "./model-ref.ts";

export type ModelProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "qwen"
  | "kimi"
  | "local";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
export type ProviderAuthMethod = "api_key" | "codex_oauth";
export type TokenEstimatorKind =
  | "provider_usage"
  | "openai_tiktoken_o200k"
  | "anthropic_count_tokens_api"
  | "gemini_count_tokens_api"
  | "gemini_character_estimate"
  | "character_estimate";

export interface ProviderModelMetadata {
  provider_id: ModelProviderId;
  provider_label: string;
  model_id: string;
  model_ref: `${ModelProviderId}/${string}`;
  display_name: string;
  status: "latest" | "recommended" | "available" | "deprecated";
  context_window_tokens: number;
  max_output_tokens: number;
  default_reasoning_effort: ReasoningEffort;
  reasoning_efforts: ReasoningEffort[];
  reasoning_budget_tokens?: Partial<Record<ReasoningEffort, number>>;
  token_estimator: TokenEstimatorKind;
  source_url: string;
  runtime_supported: boolean;
  api_type?: LocalModelApiType;
  platform?: LocalModelPlatform;
  server_url?: string;
  source?: LocalModelSource;
  local_reasoning_budget_ratio?: number;
  registered?: boolean;
  auth_type?: ProviderAuthMethod;
  credential_id?: string;
  credential_label?: string;
  credential_masked_value?: string;
}

export interface ModelCatalogView {
  generated_at: string;
  default_model_ref: `${ModelProviderId}/${string}`;
  default_reasoning_effort: ReasoningEffort;
  providers: Array<{
    provider_id: ModelProviderId;
    provider_label: string;
    latest_model_ref: `${ModelProviderId}/${string}`;
    auth_methods: ProviderAuthMethod[];
    models: ProviderModelMetadata[];
  }>;
  models: ProviderModelMetadata[];
  registered_models: ProviderModelMetadata[];
  provider_credentials: Array<{
    id: string;
    provider_id: ModelProviderId;
    auth_type: ProviderAuthMethod;
    label: string;
    masked_value: string;
    created_at: string;
    updated_at: string;
  }>;
  worker_model_presets: WorkerModelPreset[];
}

interface ModelCatalogOptions {
  defaultModelRef?: string | null;
}

export interface WorkerModelRule {
  id: string;
  label: string;
  condition: string;
  model: `${ModelProviderId}/${string}`;
  reasoning_effort: ReasoningEffort;
  enabled: boolean;
}

export interface WorkerModelPreset {
  provider_id: ModelProviderId;
  provider_label: string;
  runtime_supported: boolean;
  source_url: string;
  deep_work: WorkerModelRule;
  routine_work: WorkerModelRule;
}

const OPENAI_SOURCE = "https://developers.openai.com/api/docs/models/compare";
const ANTHROPIC_SOURCE = "https://docs.anthropic.com/en/docs/about-claude/models/all-models";
const GEMINI_SOURCE = "https://ai.google.dev/gemini-api/docs/models";
const XAI_SOURCE = "https://docs.x.ai/developers/models";
const QWEN_SOURCE = "https://docs.qwencloud.com/developer-guides/getting-started/text-generation-models";
const KIMI_SOURCE = "https://platform.kimi.ai/docs/models";

export const DEFAULT_MODEL_REF = "openai/gpt-5.5" as const;
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "xhigh";

const MODELS: ProviderModelMetadata[] = [
  {
    provider_id: "openai",
    provider_label: "OpenAI",
    model_id: "gpt-5.5",
    model_ref: "openai/gpt-5.5",
    display_name: "GPT-5.5",
    status: "latest",
    context_window_tokens: 1_050_000,
    max_output_tokens: 128_000,
    default_reasoning_effort: DEFAULT_REASONING_EFFORT,
    reasoning_efforts: ["none", "low", "medium", "high", "xhigh"],
    token_estimator: "openai_tiktoken_o200k",
    source_url: OPENAI_SOURCE,
    runtime_supported: true,
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
    reasoning_efforts: ["none", "low", "medium", "high", "xhigh"],
    token_estimator: "openai_tiktoken_o200k",
    source_url: OPENAI_SOURCE,
    runtime_supported: true,
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
    reasoning_efforts: ["none", "low", "medium", "high", "xhigh"],
    token_estimator: "openai_tiktoken_o200k",
    source_url: OPENAI_SOURCE,
    runtime_supported: true,
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
    reasoning_efforts: ["none", "low", "medium", "high", "xhigh"],
    token_estimator: "openai_tiktoken_o200k",
    source_url: OPENAI_SOURCE,
    runtime_supported: true,
  },
  {
    provider_id: "anthropic",
    provider_label: "Anthropic",
    model_id: "claude-opus-4-7",
    model_ref: "anthropic/claude-opus-4-7",
    display_name: "Claude Opus 4.7",
    status: "latest",
    context_window_tokens: 1_000_000,
    max_output_tokens: 128_000,
    default_reasoning_effort: "high",
    reasoning_efforts: ["none", "low", "medium", "high", "xhigh"],
    token_estimator: "anthropic_count_tokens_api",
    source_url: ANTHROPIC_SOURCE,
    runtime_supported: true,
  },
  {
    provider_id: "anthropic",
    provider_label: "Anthropic",
    model_id: "claude-sonnet-4-6",
    model_ref: "anthropic/claude-sonnet-4-6",
    display_name: "Claude Sonnet 4.6",
    status: "recommended",
    context_window_tokens: 1_000_000,
    max_output_tokens: 64_000,
    default_reasoning_effort: "medium",
    reasoning_efforts: ["none", "low", "medium", "high"],
    token_estimator: "anthropic_count_tokens_api",
    source_url: ANTHROPIC_SOURCE,
    runtime_supported: true,
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
    reasoning_efforts: ["none", "low", "medium"],
    token_estimator: "anthropic_count_tokens_api",
    source_url: ANTHROPIC_SOURCE,
    runtime_supported: true,
  },
  {
    provider_id: "google",
    provider_label: "Google",
    model_id: "gemini-3.1-pro",
    model_ref: "google/gemini-3.1-pro",
    display_name: "Gemini 3.1 Pro Preview",
    status: "latest",
    context_window_tokens: 1_048_576,
    max_output_tokens: 65_536,
    default_reasoning_effort: "high",
    reasoning_efforts: ["low", "medium", "high"],
    token_estimator: "gemini_count_tokens_api",
    source_url: GEMINI_SOURCE,
    runtime_supported: true,
  },
  {
    provider_id: "google",
    provider_label: "Google",
    model_id: "gemini-3.5-flash",
    model_ref: "google/gemini-3.5-flash",
    display_name: "Gemini 3.5 Flash",
    status: "recommended",
    context_window_tokens: 1_048_576,
    max_output_tokens: 65_536,
    default_reasoning_effort: "medium",
    reasoning_efforts: ["none", "low", "medium", "high"],
    token_estimator: "gemini_count_tokens_api",
    source_url: GEMINI_SOURCE,
    runtime_supported: true,
  },
  {
    provider_id: "google",
    provider_label: "Google",
    model_id: "gemini-3-flash-preview",
    model_ref: "google/gemini-3-flash-preview",
    display_name: "Gemini 3 Flash Preview",
    status: "available",
    context_window_tokens: 1_048_576,
    max_output_tokens: 65_536,
    default_reasoning_effort: "medium",
    reasoning_efforts: ["none", "low", "medium", "high"],
    token_estimator: "gemini_count_tokens_api",
    source_url: GEMINI_SOURCE,
    runtime_supported: true,
  },
  {
    provider_id: "xai",
    provider_label: "xAI / Grok",
    model_id: "grok-4.3",
    model_ref: "xai/grok-4.3",
    display_name: "Grok 4.3",
    status: "latest",
    context_window_tokens: 1_000_000,
    max_output_tokens: 128_000,
    default_reasoning_effort: "low",
    reasoning_efforts: ["none", "low", "medium", "high"],
    token_estimator: "character_estimate",
    source_url: XAI_SOURCE,
    runtime_supported: true,
  },
  {
    provider_id: "xai",
    provider_label: "xAI / Grok",
    model_id: "grok-4.20-multi-agent",
    model_ref: "xai/grok-4.20-multi-agent",
    display_name: "Grok 4.20 Multi-Agent",
    status: "available",
    context_window_tokens: 2_000_000,
    max_output_tokens: 128_000,
    default_reasoning_effort: "medium",
    reasoning_efforts: ["low", "medium", "high", "xhigh"],
    token_estimator: "character_estimate",
    source_url: XAI_SOURCE,
    runtime_supported: true,
  },
  {
    provider_id: "qwen",
    provider_label: "Qwen Cloud",
    model_id: "qwen3.7-max",
    model_ref: "qwen/qwen3.7-max",
    display_name: "Qwen3.7 Max",
    status: "latest",
    context_window_tokens: 1_048_576,
    max_output_tokens: 64_000,
    default_reasoning_effort: "high",
    reasoning_efforts: ["none", "low", "medium", "high", "xhigh"],
    reasoning_budget_tokens: { low: 8_000, medium: 32_000, high: 128_000, xhigh: 256_000 },
    token_estimator: "character_estimate",
    source_url: QWEN_SOURCE,
    runtime_supported: true,
  },
  {
    provider_id: "qwen",
    provider_label: "Qwen Cloud",
    model_id: "qwen3.6-plus",
    model_ref: "qwen/qwen3.6-plus",
    display_name: "Qwen3.6 Plus",
    status: "recommended",
    context_window_tokens: 1_048_576,
    max_output_tokens: 64_000,
    default_reasoning_effort: "medium",
    reasoning_efforts: ["none", "low", "medium", "high"],
    reasoning_budget_tokens: { low: 4_000, medium: 16_000, high: 80_000 },
    token_estimator: "character_estimate",
    source_url: QWEN_SOURCE,
    runtime_supported: true,
  },
  {
    provider_id: "qwen",
    provider_label: "Qwen Cloud",
    model_id: "qwen3.6-flash",
    model_ref: "qwen/qwen3.6-flash",
    display_name: "Qwen3.6 Flash",
    status: "available",
    context_window_tokens: 1_048_576,
    max_output_tokens: 64_000,
    default_reasoning_effort: "medium",
    reasoning_efforts: ["none", "low", "medium", "high"],
    reasoning_budget_tokens: { low: 4_000, medium: 16_000, high: 80_000 },
    token_estimator: "character_estimate",
    source_url: QWEN_SOURCE,
    runtime_supported: true,
  },
  {
    provider_id: "kimi",
    provider_label: "Moonshot / Kimi",
    model_id: "kimi-k2.6",
    model_ref: "kimi/kimi-k2.6",
    display_name: "Kimi K2.6",
    status: "latest",
    context_window_tokens: 256_000,
    max_output_tokens: 96_000,
    default_reasoning_effort: "high",
    reasoning_efforts: ["none", "high"],
    token_estimator: "character_estimate",
    source_url: KIMI_SOURCE,
    runtime_supported: true,
  },
  {
    provider_id: "kimi",
    provider_label: "Moonshot / Kimi",
    model_id: "kimi-k2.5",
    model_ref: "kimi/kimi-k2.5",
    display_name: "Kimi K2.5",
    status: "recommended",
    context_window_tokens: 256_000,
    max_output_tokens: 96_000,
    default_reasoning_effort: "high",
    reasoning_efforts: ["none", "high"],
    token_estimator: "character_estimate",
    source_url: KIMI_SOURCE,
    runtime_supported: true,
  },
];

let openAIEncoding: Tiktoken | null = null;

function openAITextEncoding(): Tiktoken {
  if (openAIEncoding) return openAIEncoding;
  openAIEncoding = getEncoding("o200k_base");
  return openAIEncoding;
}

export function localModelConfigToMetadata(model: LocalModelConfig): ProviderModelMetadata {
  const reasoningBudgetTokens = localReasoningBudgetTokens(model);
  const reasoningEfforts: ReasoningEffort[] = reasoningBudgetTokens
    ? ["none", "high"]
    : ["none"];
  return {
    provider_id: "local",
    provider_label: model.provider_label,
    model_id: model.model_id,
    model_ref: model.model_ref,
    display_name: model.display_name,
    status: "available",
    context_window_tokens: model.context_window_tokens,
    max_output_tokens: model.max_output_tokens,
    default_reasoning_effort: reasoningBudgetTokens ? "high" : "none",
    reasoning_efforts: reasoningEfforts,
    ...(reasoningBudgetTokens
      ? {
        reasoning_budget_tokens: {
          high: reasoningBudgetTokens,
        },
      }
      : {}),
    token_estimator: model.token_estimator,
    source_url: model.source_url,
    runtime_supported: true,
    api_type: model.api_type,
    platform: model.platform,
    server_url: model.server_url,
    source: model.source,
    local_reasoning_budget_ratio: model.reasoning_budget_ratio,
  };
}

function localReasoningBudgetTokens(model: LocalModelConfig): number | null {
  const ratio = model.reasoning_budget_ratio;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0) return null;
  const maxOutputTokens = Number.isFinite(model.max_output_tokens)
    ? Math.trunc(model.max_output_tokens)
    : 0;
  if (maxOutputTokens <= 0) return null;
  const budget = Math.round(maxOutputTokens * Math.min(1, ratio));
  return budget > 0 ? budget : null;
}

export function listModelMetadata(extraModels: ProviderModelMetadata[] = []): ProviderModelMetadata[] {
  return [...MODELS, ...extraModels].map((model) => ({
    ...model,
    reasoning_efforts: [...model.reasoning_efforts],
  }));
}

export function providerAuthMethods(providerId: ModelProviderId): ProviderAuthMethod[] {
  if (providerId === "openai") return ["api_key", "codex_oauth"];
  if (providerId === "local") return [];
  return ["api_key"];
}

function configuredLocalModelMetadata(): ProviderModelMetadata[] {
  try {
    return readLocalModelConfigs().map(localModelConfigToMetadata);
  } catch {
    return [];
  }
}

function lookupModelMetadata(extraModels: ProviderModelMetadata[] = []): ProviderModelMetadata[] {
  const byRef = new Map<string, ProviderModelMetadata>();
  for (const model of [...MODELS, ...configuredLocalModelMetadata(), ...extraModels]) {
    byRef.set(model.model_ref, {
      ...model,
      reasoning_efforts: [...model.reasoning_efforts],
    });
  }
  return [...byRef.values()];
}

export function defaultWorkerModelRules(): WorkerModelRule[] {
  return workerModelPresets().find((preset) => preset.provider_id === "openai")?.runtime_supported
    ? cloneWorkerRules([
      {
        id: "deep_work",
        label: "Deep work",
        condition: "Research, feature-level development, architecture, review, and analysis",
        model: "openai/gpt-5.5",
        reasoning_effort: "high",
        enabled: true,
      },
      {
        id: "routine_work",
        label: "Routine work",
        condition: "Simple coding, search, local inspection, formatting, and tool calls",
        model: "openai/gpt-5.4-mini",
        reasoning_effort: "medium",
        enabled: true,
      },
    ])
    : [];
}

export function workerModelPresets(): WorkerModelPreset[] {
  const presets = [
    {
      provider_id: "openai",
      provider_label: "OpenAI",
      runtime_supported: true,
      source_url: OPENAI_SOURCE,
      deep_work: {
        id: "deep_work",
        label: "Deep work",
        condition: "Research, feature-level development, architecture, review, and analysis",
        model: "openai/gpt-5.5",
        reasoning_effort: "high",
        enabled: true,
      },
      routine_work: {
        id: "routine_work",
        label: "Routine work",
        condition: "Simple coding, search, local inspection, formatting, and tool calls",
        model: "openai/gpt-5.4-mini",
        reasoning_effort: "medium",
        enabled: true,
      },
    },
    {
      provider_id: "anthropic",
      provider_label: "Anthropic",
      runtime_supported: true,
      source_url: ANTHROPIC_SOURCE,
      deep_work: {
        id: "deep_work",
        label: "Deep work",
        condition: "Research, feature-level development, architecture, review, and analysis",
        model: "anthropic/claude-opus-4-7",
        reasoning_effort: "high",
        enabled: true,
      },
      routine_work: {
        id: "routine_work",
        label: "Routine work",
        condition: "Simple coding, search, local inspection, formatting, and tool calls",
        model: "anthropic/claude-sonnet-4-6",
        reasoning_effort: "medium",
        enabled: true,
      },
    },
    {
      provider_id: "google",
      provider_label: "Google",
      runtime_supported: true,
      source_url: GEMINI_SOURCE,
      deep_work: {
        id: "deep_work",
        label: "Deep work",
        condition: "Research, feature-level development, architecture, review, and analysis",
        model: "google/gemini-3.1-pro-preview",
        reasoning_effort: "high",
        enabled: true,
      },
      routine_work: {
        id: "routine_work",
        label: "Routine work",
        condition: "Simple coding, search, local inspection, formatting, and tool calls",
        model: "google/gemini-2.5-pro",
        reasoning_effort: "medium",
        enabled: true,
      },
    },
  ] satisfies WorkerModelPreset[];

  return presets.map((preset) => ({
    ...preset,
    deep_work: { ...preset.deep_work },
    routine_work: { ...preset.routine_work },
  }));
}

function cloneWorkerRules(rules: WorkerModelRule[]): WorkerModelRule[] {
  return rules.map((rule) => ({ ...rule }));
}

export function modelCatalogView(
  extraModels: ProviderModelMetadata[] = [],
  registeredModels: ProviderModelMetadata[] = extraModels,
  providerCredentials: ModelCatalogView["provider_credentials"] = [],
  options: ModelCatalogOptions = {},
): ModelCatalogView {
  const models = listModelMetadata(extraModels);
  const defaultModel = resolveModelMetadata(
    options.defaultModelRef ?? DEFAULT_MODEL_REF,
    extraModels,
  );
  const providers = Array.from(new Set(models.map((model) => model.provider_id))).map((providerId) => {
    const providerModels = models.filter((model) => model.provider_id === providerId);
    const latest = providerModels.find((model) => model.status === "latest") ?? providerModels[0]!;
    return {
      provider_id: providerId,
      provider_label: latest.provider_label,
      latest_model_ref: latest.model_ref,
      auth_methods: providerAuthMethods(providerId),
      models: providerModels,
    };
  });
  return {
    generated_at: new Date().toISOString(),
    default_model_ref: defaultModel.model_ref,
    default_reasoning_effort: defaultModel.default_reasoning_effort,
    providers,
    models,
    registered_models: registeredModels.map((model) => ({
      ...model,
      registered: true,
      reasoning_efforts: [...model.reasoning_efforts],
    })),
    provider_credentials: providerCredentials.map((credential) => ({ ...credential })),
    worker_model_presets: workerModelPresets(),
  };
}

export function resolveRegisteredRuntimeModelMetadata(
  modelRef: string | null | undefined,
  registeredModels: ProviderModelMetadata[] = [],
): ProviderModelMetadata {
  const selectable = registeredModels.filter((model) => model.runtime_supported);
  if (selectable.length === 0) return resolveRuntimeModelMetadata(modelRef);
  const parsed = parseModelRef(modelRef?.trim() || selectable[0]!.model_ref);
  const exact = selectable.find((model) =>
    model.model_ref === parsed.canonicalRef || model.model_id === parsed.modelId,
  );
  const fallback = exact ??
    selectable.find((model) => model.provider_id === parsed.providerId) ??
    selectable[0]!;
  return { ...fallback, reasoning_efforts: [...fallback.reasoning_efforts] };
}

export function resolveModelMetadata(
  modelRef?: string | null,
  extraModels: ProviderModelMetadata[] = [],
): ProviderModelMetadata {
  const parsed = parseModelRef(modelRef?.trim() || DEFAULT_MODEL_REF);
  const models = lookupModelMetadata(extraModels);
  const exact = models.find((model) => model.model_ref === parsed.canonicalRef || model.model_id === parsed.modelId);
  if (exact) return { ...exact, reasoning_efforts: [...exact.reasoning_efforts] };
  const providerDefault = models.find((model) => model.provider_id === parsed.providerId && model.status === "latest");
  if (providerDefault) return { ...providerDefault, reasoning_efforts: [...providerDefault.reasoning_efforts] };
  return { ...MODELS[0]!, reasoning_efforts: [...MODELS[0]!.reasoning_efforts] };
}

export function resolveRuntimeModelMetadata(
  modelRef?: string | null,
  extraModels: ProviderModelMetadata[] = [],
): ProviderModelMetadata {
  const parsed = parseModelRef(modelRef?.trim() || DEFAULT_MODEL_REF);
  const models = lookupModelMetadata(extraModels);
  const exact = models.find((model) =>
    model.runtime_supported && (model.model_ref === parsed.canonicalRef || model.model_id === parsed.modelId),
  );
  if (exact) return { ...exact, reasoning_efforts: [...exact.reasoning_efforts] };
  const providerDefault = models.find((model) =>
    model.runtime_supported && model.provider_id === parsed.providerId && model.status === "latest",
  );
  if (providerDefault) return { ...providerDefault, reasoning_efforts: [...providerDefault.reasoning_efforts] };
  const defaultModel = MODELS.find((model) => model.model_ref === DEFAULT_MODEL_REF && model.runtime_supported) ?? MODELS[0]!;
  return { ...defaultModel, reasoning_efforts: [...defaultModel.reasoning_efforts] };
}

export function estimateTokensForModel(
  value: string | number | null | undefined,
  modelRef?: string | null,
): { tokens: number; source: TokenEstimatorKind } {
  if (typeof value === "number") {
    return { tokens: Math.max(0, Math.ceil(value / 4)), source: "character_estimate" };
  }
  const text = value ?? "";
  if (!text) return { tokens: 0, source: "character_estimate" };
  const metadata = resolveModelMetadata(modelRef);
  if (metadata.provider_id === "openai") {
    return { tokens: openAITextEncoding().encode(text).length, source: "openai_tiktoken_o200k" };
  }
  if (metadata.provider_id === "google") {
    return { tokens: Math.ceil(text.length / 4), source: "gemini_character_estimate" };
  }
  return { tokens: Math.ceil(text.length / 3.8), source: "character_estimate" };
}
