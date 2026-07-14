import { getEncoding, type Tiktoken } from "js-tiktoken";
import { createHash } from "node:crypto";
import { HOSTED_PROVIDER_MODELS } from "./shared/hosted-models.ts";
import { localModelConfigToMetadata } from "./local/catalog.ts";
import { workerModelPresets } from "./shared/worker-presets.ts";
import { readLocalModelConfigs, type LocalModelApiType, type LocalModelPlatform, type LocalModelSource } from "./local/models.ts";
import { parseModelRef, type ParsedModelRef } from "./model-ref.ts";

export type ModelProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "qwen"
  | "kimi"
  | "zai"
  | "opencode-go"
  | "local";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type ProviderAuthMethod = "api_key" | "codex_oauth";
export type HostedProviderApiShape = "openai_chat_completions" | "anthropic_messages";
export type StructuredDecisionTransport = "json_schema" | "function_tool";
const FUNCTION_TOOL_DECISION_PROVIDERS = new Set<string>([
  "anthropic",
  "google",
  "xai",
  "qwen",
  "kimi",
  "zai",
  "opencode-go",
]);
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
  hosted_api_shape?: HostedProviderApiShape;
  api_base_url?: string;
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
  generation: string;
  generated_at: string;
  default_model_ref: `${ModelProviderId}/${string}`;
  default_reasoning_effort: ReasoningEffort;
  providers: Array<{
    provider_id: ModelProviderId;
    provider_label: string;
    latest_model_ref: `${ModelProviderId}/${string}`;
    auth_methods: ProviderAuthMethod[];
    default_api_base_url?: string;
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

export const DEFAULT_MODEL_REF = "openai/gpt-5.5" as const;
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "xhigh";

export { localModelConfigToMetadata } from "./local/catalog.ts";
export { defaultWorkerModelRules, workerModelPresets } from "./shared/worker-presets.ts";

const MODELS: readonly ProviderModelMetadata[] = HOSTED_PROVIDER_MODELS;
let openAIEncoding: Tiktoken | null = null;

function openAITextEncoding(): Tiktoken {
  if (openAIEncoding) return openAIEncoding;
  openAIEncoding = getEncoding("o200k_base");
  return openAIEncoding;
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

export function defaultHostedProviderApiBaseUrl(
  providerId: ModelProviderId,
): string | undefined {
  if (providerId === "xai") return "https://api.x.ai/v1";
  if (providerId === "qwen") return "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  if (providerId === "kimi") return "https://api.moonshot.ai/v1";
  if (providerId === "zai") return "https://api.z.ai/api/paas/v4";
  if (providerId === "opencode-go") return "https://opencode.ai/zen/go/v1";
  return undefined;
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

function matchesParsedModelRef(
  model: Pick<ProviderModelMetadata, "model_ref" | "provider_id" | "model_id">,
  parsed: ParsedModelRef,
): boolean {
  if (model.model_ref === parsed.canonicalRef) return true;
  if (parsed.source === "namespaced") {
    return model.provider_id === parsed.providerId && model.model_id === parsed.modelId;
  }
  return model.model_id === parsed.modelId;
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
      default_api_base_url: defaultHostedProviderApiBaseUrl(providerId),
      models: providerModels,
    };
  });
  return {
    generation: modelCatalogGeneration(
      registeredModels.length > 0 ? registeredModels : models,
    ),
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

export function modelCatalogGeneration(
  registeredModels: readonly ProviderModelMetadata[],
): string {
  const stableModels = registeredModels
    .map((model) => ({
      model_ref: model.model_ref,
      runtime_supported: model.runtime_supported,
      reasoning_efforts: [...model.reasoning_efforts].sort(),
      default_reasoning_effort: model.default_reasoning_effort,
    }))
    .sort((left, right) => left.model_ref.localeCompare(right.model_ref));
  return createHash("sha256")
    .update(JSON.stringify(stableModels))
    .digest("hex");
}

export function resolveRegisteredRuntimeModelMetadata(
  modelRef: string | null | undefined,
  registeredModels: ProviderModelMetadata[] = [],
): ProviderModelMetadata {
  const selectable = registeredModels.filter((model) => model.runtime_supported);
  if (selectable.length === 0) return resolveRuntimeModelMetadata(modelRef);
  const parsed = parseModelRef(modelRef?.trim() || selectable[0]!.model_ref);
  const exact = selectable.find((model) => matchesParsedModelRef(model, parsed));
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
  const exact = models.find((model) => matchesParsedModelRef(model, parsed));
  if (exact) return { ...exact, reasoning_efforts: [...exact.reasoning_efforts] };
  const providerDefault = models.find((model) => model.provider_id === parsed.providerId && model.status === "latest");
  if (providerDefault) return { ...providerDefault, reasoning_efforts: [...providerDefault.reasoning_efforts] };
  return { ...MODELS[0]!, reasoning_efforts: [...MODELS[0]!.reasoning_efforts] };
}

export function modelSupportsJsonSchemaResponseFormat(modelRef?: string | null): boolean {
  const parsed = parseModelRef(modelRef?.trim() || DEFAULT_MODEL_REF);
  return parsed.providerId === "openai";
}

export function modelStructuredDecisionTransport(
  modelRef?: string | null,
): StructuredDecisionTransport | null {
  const parsed = parseModelRef(modelRef?.trim() || DEFAULT_MODEL_REF);
  if (modelSupportsJsonSchemaResponseFormat(modelRef)) return "json_schema";
  if (FUNCTION_TOOL_DECISION_PROVIDERS.has(parsed.providerId)) return "function_tool";
  return null;
}

export function resolveRuntimeModelMetadata(
  modelRef?: string | null,
  extraModels: ProviderModelMetadata[] = [],
): ProviderModelMetadata {
  const parsed = parseModelRef(modelRef?.trim() || DEFAULT_MODEL_REF);
  const models = lookupModelMetadata(extraModels);
  const exact = models.find((model) =>
    model.runtime_supported && matchesParsedModelRef(model, parsed),
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
