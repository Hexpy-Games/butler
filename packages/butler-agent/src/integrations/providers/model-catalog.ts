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
  | "zai-api"
  | "opencode-go"
  | "local";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type ProviderAuthMethod = "api_key" | "codex_oauth";
/**
 * The wire carrier is part of the model contract.  A provider may expose
 * more than one carrier (OpenCode Go is the current example), so callers
 * must resolve the shape from the admitted model instead of guessing from
 * the provider id.
 */
export type HostedProviderApiShape =
  | "openai_chat_completions"
  | "openai_responses"
  | "anthropic_messages"
  | "gemini_generate_content";
export type StructuredDecisionTransport = "json_schema" | "function_tool";
const FUNCTION_TOOL_DECISION_PROVIDERS = new Set<string>([
  "anthropic",
  "google",
  "xai",
  "qwen",
  "kimi",
  "zai",
  "zai-api",
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
  /**
   * Billing/auth surfaces may have distinct provider ids while sharing one
   * model family for Backup-model duplicate sanitization.
   */
  provider_family_id?: string;
  model_id: string;
  model_ref: `${ModelProviderId}/${string}`;
  /**
   * Stable identifiers that the provider catalog explicitly maps to this
   * model.  A model id is intentionally not treated as an alias implicitly:
   * the same id is common across multiple provider carriers (for example
   * Z.AI Coding Plan/API), so an unqualified lookup must never pick a model
   * merely because it happens to be first in the catalog.
   */
  aliases?: readonly string[];
  display_name: string;
  status: "latest" | "recommended" | "available" | "deprecated";
  /** Provider-published capacities. Some aggregator catalogs intentionally
   * omit these until their `/models` record proves them. */
  context_window_tokens?: number;
  max_output_tokens?: number;
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
  enabled?: boolean;
  auth_type?: ProviderAuthMethod;
  credential_id?: string;
  credential_label?: string;
  credential_masked_value?: string;
  /**
   * Image input is opt-in and exact-tuple verified. Missing or dynamic values
   * deliberately mean unsupported at message admission; provider id alone is
   * never treated as an image capability.
   */
  image_input_verified?: boolean;
  image_input_modalities?: readonly ("text" | "image")[];
  image_accepted_mime_types?: readonly string[];
  image_max_inline_bytes?: number;
  image_max_width?: number;
  image_max_height?: number;
  image_max_pixels?: number;
  image_capability_source_url?: string;
  image_capability_verified_at?: string;
  image_capability_revision?: string;
  image_capability_digest?: string;
  image_endpoint_profile_id?: string;
  image_carrier_protocol?: "openai_responses" | "openai_chat_completions" | "zai_mcp_vision" | "fake_vision";
  image_tool_server_id?: string;
  image_tool_name?: string;
  image_tool_capability_digest?: string;
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
    ...(model.aliases ? { aliases: [...model.aliases] } : {}),
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
  if (providerId === "zai") return "https://api.z.ai/api/coding/paas/v4";
  if (providerId === "zai-api") return "https://api.z.ai/api/paas/v4";
  if (providerId === "opencode-go") return "https://opencode.ai/zen/go/v1";
  return undefined;
}

/**
 * Returns the documented default endpoint for a hosted model carrier.  The
 * base URL remains separately configurable in Settings; this helper is used
 * by contract tests and diagnostics so a provider cannot silently switch
 * between its general and Coding Plan endpoints.
 */
export function defaultHostedProviderApiEndpoint(
  providerId: ModelProviderId,
  apiShape?: HostedProviderApiShape,
): string | undefined {
  const base = defaultHostedProviderApiBaseUrl(providerId);
  if (providerId === "anthropic") return "https://api.anthropic.com/v1/messages";
  if (providerId === "google") {
    return "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent";
  }
  if (providerId === "xai") return "https://api.x.ai/v1/responses";
  if (providerId === "kimi") return "https://api.moonshot.ai/v1/chat/completions";
  if (providerId === "qwen") {
    return "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";
  }
  if (providerId === "zai") return "https://api.z.ai/api/coding/paas/v4/chat/completions";
  if (providerId === "zai-api") return "https://api.z.ai/api/paas/v4/chat/completions";
  if (providerId === "opencode-go") {
    const shape = apiShape ?? "openai_chat_completions";
    if (shape === "openai_responses") return "https://opencode.ai/zen/go/v1/responses";
    if (shape === "anthropic_messages") return "https://opencode.ai/zen/go/v1/messages";
    return "https://opencode.ai/zen/go/v1/chat/completions";
  }
  if (base) return `${base}/responses`;
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
      ...(model.aliases ? { aliases: [...model.aliases] } : {}),
      reasoning_efforts: [...model.reasoning_efforts],
    });
  }
  return [...byRef.values()];
}

function matchesParsedModelRef(
  model: Pick<ProviderModelMetadata, "model_ref" | "provider_id" | "aliases">,
  parsed: ParsedModelRef,
): boolean {
  if (model.model_ref === parsed.canonicalRef) return true;
  const aliases = model.aliases ?? [];
  if (aliases.includes(parsed.input) || aliases.includes(parsed.canonicalRef)) {
    return true;
  }
  if (parsed.source === "namespaced") {
    return model.provider_id === parsed.providerId && aliases.includes(parsed.modelId);
  }
  return false;
}

/**
 * Find one exact catalog entry or one explicitly declared alias.  Returning
 * undefined for an ambiguous alias is deliberate: callers must surface the
 * unavailable configuration rather than silently selecting a provider.
 */
export function findModelMetadata(
  modelRef: string | null | undefined,
  models: readonly ProviderModelMetadata[] = listModelMetadata(),
): ProviderModelMetadata | undefined {
  const parsed = parseModelRef(modelRef?.trim() || "");
  if (!parsed.input) return undefined;
  const exact = models.filter((model) => model.model_ref === parsed.canonicalRef);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const aliases = models.filter((model) => matchesParsedModelRef(model, parsed));
  return aliases.length === 1 ? aliases[0] : undefined;
}

function cloneModelMetadata(model: ProviderModelMetadata): ProviderModelMetadata {
  return {
    ...model,
    ...(model.aliases ? { aliases: [...model.aliases] } : {}),
    reasoning_efforts: [...model.reasoning_efforts],
  };
}

function unavailableModelMetadata(
  parsed: ParsedModelRef,
  reason: "missing" | "retired" = "missing",
): ProviderModelMetadata {
  return {
    provider_id: parsed.providerId as ModelProviderId,
    provider_label: "Unavailable model",
    model_id: parsed.modelId,
    model_ref: parsed.canonicalRef as `${ModelProviderId}/${string}`,
    display_name: `${parsed.canonicalRef} (${reason})`,
    status: "deprecated",
    default_reasoning_effort: "medium",
    reasoning_efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    token_estimator: "character_estimate",
    source_url: "about:blank",
    runtime_supported: false,
  };
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
      ...(model.aliases ? { aliases: [...model.aliases] } : {}),
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
      aliases: model.aliases ? [...model.aliases].sort() : undefined,
      provider_family_id: model.provider_family_id,
      runtime_supported: model.runtime_supported,
      hosted_api_shape: model.hosted_api_shape,
      context_window_tokens: model.context_window_tokens,
      max_output_tokens: model.max_output_tokens,
      source_url: model.source_url,
      reasoning_efforts: [...model.reasoning_efforts].sort(),
      default_reasoning_effort: model.default_reasoning_effort,
    }))
    .sort((left, right) => left.model_ref.localeCompare(right.model_ref));
  return createHash("sha256")
    .update(JSON.stringify(stableModels))
    .digest("hex");
}

/**
 * Returns the provider family used for model identity and duplicate checks.
 * Provider ids remain canonical for routing/credentials; family ids only
 * collapse equivalent billing surfaces such as Z.AI Coding Plan/API.
 */
export function modelProviderFamilyId(
  model: Pick<ProviderModelMetadata, "provider_id" | "provider_family_id">,
): string {
  return model.provider_family_id?.trim() || model.provider_id;
}

export function modelIdentityKey(
  model: Pick<ProviderModelMetadata, "provider_id" | "provider_family_id" | "model_id">,
): string {
  return `${modelProviderFamilyId(model)}:${model.model_id}`;
}

export function resolveRegisteredRuntimeModelMetadata(
  modelRef: string | null | undefined,
  registeredModels: ProviderModelMetadata[] = [],
): ProviderModelMetadata {
  const selectable = registeredModels.filter((model) => model.runtime_supported);
  if (selectable.length === 0) return resolveRuntimeModelMetadata(modelRef);
  const requested = modelRef?.trim();
  if (!requested) return cloneModelMetadata(selectable[0]!);
  const exact = findModelMetadata(requested, selectable);
  if (exact) return cloneModelMetadata(exact);
  return resolveRuntimeModelMetadata(requested);
}

export function resolveModelMetadata(
  modelRef?: string | null,
  extraModels: ProviderModelMetadata[] = [],
): ProviderModelMetadata {
  const parsed = parseModelRef(modelRef?.trim() || DEFAULT_MODEL_REF);
  const models = lookupModelMetadata(extraModels);
  const exact = findModelMetadata(parsed.input, models);
  if (exact) {
    return cloneModelMetadata(exact);
  }
  return unavailableModelMetadata(parsed);
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
  const exact = findModelMetadata(parsed.input, models);
  if (exact) {
    return cloneModelMetadata(exact);
  }
  return unavailableModelMetadata(parsed);
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
