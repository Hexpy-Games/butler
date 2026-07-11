import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type LocalModelApiType = "openai_compatible";
export type LocalModelPlatform = "llama_cpp" | "ollama" | "lm_studio" | "custom";
export type LocalModelSource = "discovered" | "manual";

export interface LocalModelConfig {
  provider_id: "local";
  provider_label: "Local";
  model_id: string;
  model_ref: `local/${string}`;
  display_name: string;
  api_type: LocalModelApiType;
  platform: LocalModelPlatform;
  server_url: string;
  api_base_url: string;
  context_window_tokens: number;
  max_output_tokens: number;
  reasoning_budget_ratio?: number;
  token_estimator: "character_estimate";
  source: LocalModelSource;
  source_url: string;
  runtime_supported: true;
  created_at: string;
  updated_at: string;
}

export interface LocalModelDiscoveryInput {
  serverUrl: string;
  apiType?: LocalModelApiType;
  platform?: LocalModelPlatform;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface DiscoveredLocalModel {
  provider_id: "local";
  provider_label: "Local";
  model_id: string;
  model_ref: `local/${string}`;
  display_name: string;
  api_type: LocalModelApiType;
  platform: LocalModelPlatform;
  server_url: string;
  api_base_url: string;
  context_window_tokens: number;
  max_output_tokens: number;
  reasoning_budget_ratio?: number;
  token_estimator: "character_estimate";
  source: "discovered";
  source_url: string;
  runtime_supported: true;
}

export interface LocalModelDiscoveryResult {
  server_url: string;
  api_base_url: string;
  api_type: LocalModelApiType;
  platform: LocalModelPlatform;
  models: DiscoveredLocalModel[];
}

export interface LocalModelRegistrationInput {
  serverUrl: string;
  apiType?: LocalModelApiType;
  platform?: LocalModelPlatform;
  modelId: string;
  displayName?: string;
  contextWindowTokens: number;
  maxOutputTokens?: number;
  reasoningBudgetRatio?: number;
  source?: LocalModelSource;
}

export interface LocalModelUpdateResult {
  model: LocalModelConfig;
  previousModelRef: `local/${string}`;
}

interface ButlerConfig {
  models?: {
    local?: unknown;
    [key: string]: unknown;
  };
  localModels?: unknown;
  [key: string]: unknown;
}

const LOCAL_MODEL_SOURCE_URL = "https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md";
const DEFAULT_LOCAL_CONTEXT_WINDOW_TOKENS = 16_384;
const DEFAULT_LOCAL_MAX_OUTPUT_TOKENS = 4_096;

function defaultButlerData(): string {
  return process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function configPath(butlerData = defaultButlerData()): string {
  return join(butlerData, "butler.config.json");
}

function readButlerConfig(butlerData = defaultButlerData()): ButlerConfig {
  const path = configPath(butlerData);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ButlerConfig : {};
  } catch {
    return {};
  }
}

function writeButlerConfig(config: ButlerConfig, butlerData = defaultButlerData()): void {
  const path = configPath(butlerData);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(tmpPath, path);
}

function normalizeApiType(value: unknown): LocalModelApiType {
  return value === "openai_compatible" ? value : "openai_compatible";
}

export function normalizeLocalModelPlatform(value: unknown): LocalModelPlatform {
  if (value === "llama_cpp" || value === "ollama" || value === "lm_studio" || value === "custom") return value;
  return "custom";
}

export function normalizeLocalServerUrl(value: string): {
  serverUrl: string;
  apiBaseUrl: string;
} {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Local model server URL is required.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withScheme);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Local model server URL must use http or https.");
  }
  if (!url.hostname) {
    throw new Error("Local model server URL must include a host.");
  }
  if (url.username || url.password) {
    throw new Error("Local model server URL must not include credentials.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/u, "");
  const serverUrl = url.toString().replace(/\/$/u, "");
  const apiBaseUrl = serverUrl.endsWith("/v1") ? serverUrl : `${serverUrl}/v1`;
  return { serverUrl, apiBaseUrl };
}

export function localServerRootFromApiBase(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/v1$/u, "");
}

export function safeLocalModelId(value: string): string {
  const normalized = value
    .trim()
    .replace(/^local\//u, "")
    .replace(/[\\/]+/gu, "-")
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .replace(/\s+/gu, "-")
    .replace(/^\/+|\/+$/gu, "");
  return normalized || "local-model";
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function normalizeReasoningBudgetRatio(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.max(0, Math.min(1, value));
  return normalized > 0 ? Number(normalized.toFixed(4)) : undefined;
}

function displayNameForModelId(modelId: string): string {
  return modelId.replace(/\.(?:gguf|bin|safetensors)$/iu, "").replace(/[-_]+/gu, " ").trim() || modelId;
}

function normalizeLocalModelConfig(value: unknown): LocalModelConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Partial<LocalModelConfig>;
  const modelId = typeof input.model_id === "string" ? safeLocalModelId(input.model_id) : "";
  const contextWindowTokens = positiveInteger(input.context_window_tokens);
  if (!modelId || !contextWindowTokens) return null;
  let server;
  try {
    server = normalizeLocalServerUrl(typeof input.server_url === "string" ? input.server_url : "");
  } catch {
    return null;
  }
  const now = new Date().toISOString();
  return {
    provider_id: "local",
    provider_label: "Local",
    model_id: modelId,
    model_ref: `local/${modelId}`,
    display_name: typeof input.display_name === "string" && input.display_name.trim()
      ? input.display_name.trim()
      : displayNameForModelId(modelId),
    api_type: normalizeApiType(input.api_type),
    platform: normalizeLocalModelPlatform(input.platform),
    server_url: server.serverUrl,
    api_base_url: server.apiBaseUrl,
    context_window_tokens: contextWindowTokens,
    max_output_tokens: positiveInteger(input.max_output_tokens) ?? Math.min(DEFAULT_LOCAL_MAX_OUTPUT_TOKENS, contextWindowTokens),
    reasoning_budget_ratio: normalizeReasoningBudgetRatio(input.reasoning_budget_ratio),
    token_estimator: "character_estimate",
    source: input.source === "manual" ? "manual" : "discovered",
    source_url: typeof input.source_url === "string" && input.source_url.trim() ? input.source_url.trim() : LOCAL_MODEL_SOURCE_URL,
    runtime_supported: true,
    created_at: typeof input.created_at === "string" ? input.created_at : now,
    updated_at: typeof input.updated_at === "string" ? input.updated_at : now,
  };
}

export function readLocalModelConfigs(butlerData = defaultButlerData()): LocalModelConfig[] {
  const config = readButlerConfig(butlerData);
  const raw = Array.isArray(config.models?.local)
    ? config.models.local
    : Array.isArray(config.localModels)
      ? config.localModels
      : [];
  const seen = new Set<string>();
  const models: LocalModelConfig[] = [];
  for (const item of raw) {
    const model = normalizeLocalModelConfig(item);
    if (!model || seen.has(model.model_ref)) continue;
    seen.add(model.model_ref);
    models.push(model);
  }
  return models;
}

function normalizeLocalModelInput(
  input: LocalModelRegistrationInput,
  previous?: LocalModelConfig,
): LocalModelConfig {
  const server = normalizeLocalServerUrl(input.serverUrl);
  const modelId = safeLocalModelId(input.modelId);
  const contextWindowTokens = positiveInteger(input.contextWindowTokens);
  if (!modelId) throw new Error("Local model id is required.");
  if (!contextWindowTokens) throw new Error("Local model context window tokens are required.");

  const now = new Date().toISOString();
  return {
    provider_id: "local",
    provider_label: "Local",
    model_id: modelId,
    model_ref: `local/${modelId}`,
    display_name: input.displayName?.trim() || displayNameForModelId(modelId),
    api_type: normalizeApiType(input.apiType),
    platform: normalizeLocalModelPlatform(input.platform),
    server_url: server.serverUrl,
    api_base_url: server.apiBaseUrl,
    context_window_tokens: contextWindowTokens,
    max_output_tokens: positiveInteger(input.maxOutputTokens) ?? Math.min(DEFAULT_LOCAL_MAX_OUTPUT_TOKENS, contextWindowTokens),
    reasoning_budget_ratio: normalizeReasoningBudgetRatio(input.reasoningBudgetRatio),
    token_estimator: "character_estimate",
    source: input.source === "manual" ? "manual" : "discovered",
    source_url: LOCAL_MODEL_SOURCE_URL,
    runtime_supported: true,
    created_at: previous?.created_at ?? now,
    updated_at: now,
  };
}

function modelRefFromLookup(value: string): `local/${string}` {
  const trimmed = value.trim();
  if (trimmed.startsWith("local/")) return `local/${safeLocalModelId(trimmed)}`;
  return `local/${safeLocalModelId(trimmed)}`;
}

function findLocalModelConfig(models: LocalModelConfig[], lookup: string): LocalModelConfig | undefined {
  const modelRef = modelRefFromLookup(lookup);
  const modelId = safeLocalModelId(lookup);
  return models.find((model) => model.model_ref === modelRef || model.model_id === modelId);
}

function writeLocalModelConfigs(models: LocalModelConfig[], butlerData = defaultButlerData()): void {
  const config = readButlerConfig(butlerData);
  writeButlerConfig({
    ...config,
    models: {
      ...(config.models && typeof config.models === "object" ? config.models : {}),
      local: models,
    },
  }, butlerData);
}

export function upsertLocalModelConfig(input: LocalModelRegistrationInput, butlerData = defaultButlerData()): LocalModelConfig {
  const existing = readLocalModelConfigs(butlerData);
  const candidate = normalizeLocalModelInput(input, findLocalModelConfig(existing, input.modelId));

  const previous = existing.find((model) => model.model_ref === candidate.model_ref);
  const next = existing.filter((model) => model.model_ref !== candidate.model_ref);
  next.push({
    ...candidate,
    created_at: previous?.created_at ?? candidate.created_at,
  });

  writeLocalModelConfigs(next, butlerData);

  return next.find((model) => model.model_ref === candidate.model_ref)!;
}

export function updateLocalModelConfig(
  lookup: string,
  input: LocalModelRegistrationInput,
  butlerData = defaultButlerData(),
): LocalModelUpdateResult {
  const existing = readLocalModelConfigs(butlerData);
  const previous = findLocalModelConfig(existing, lookup);
  if (!previous) throw new Error("Local model is not registered.");
  const candidate = normalizeLocalModelInput(input, previous);
  const next = existing.filter((model) =>
    model.model_ref !== previous.model_ref &&
    model.model_ref !== candidate.model_ref,
  );
  next.push(candidate);
  writeLocalModelConfigs(next, butlerData);
  return {
    model: candidate,
    previousModelRef: previous.model_ref,
  };
}

export function deleteLocalModelConfig(
  lookup: string,
  butlerData = defaultButlerData(),
): LocalModelConfig {
  const existing = readLocalModelConfigs(butlerData);
  const previous = findLocalModelConfig(existing, lookup);
  if (!previous) throw new Error("Local model is not registered.");
  writeLocalModelConfigs(
    existing.filter((model) => model.model_ref !== previous.model_ref),
    butlerData,
  );
  return previous;
}

function jsonNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function contextFromArgs(args: unknown): number | null {
  if (!Array.isArray(args)) return null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if ((arg === "-ctx" || arg === "--ctx-size" || arg === "-c") && typeof args[index + 1] === "string") {
      const parsed = Number(args[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
    }
  }
  return null;
}

function contextFromProps(props: Record<string, any> | null): number | null {
  if (!props) return null;
  return positiveInteger(jsonNumber(props.default_generation_settings?.n_ctx)) ??
    positiveInteger(jsonNumber(props.default_generation_settings?.params?.n_ctx)) ??
    positiveInteger(jsonNumber(props.n_ctx)) ??
    positiveInteger(jsonNumber(props.model_meta?.n_ctx)) ??
    positiveInteger(jsonNumber(props.model_meta?.n_ctx_train));
}

function contextFromModel(model: Record<string, any>): number | null {
  return positiveInteger(jsonNumber(model.meta?.n_ctx)) ??
    contextFromArgs(model.status?.args) ??
    positiveInteger(jsonNumber(model.meta?.n_ctx_train)) ??
    positiveInteger(jsonNumber(model.max_model_len)) ??
    positiveInteger(jsonNumber(model.max_context_len)) ??
    positiveInteger(jsonNumber(model.context_length));
}

async function fetchJson(url: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<Record<string, any> | null> {
  if (signal?.aborted) throw new Error("Local model discovery was cancelled.");
  try {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) return null;
    const body = await response.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, any> : null;
  } catch {
    return null;
  }
}

async function fetchProps(input: {
  serverRoot: string;
  modelId?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, any> | null> {
  const base = `${input.serverRoot}/props`;
  const queryUrl = input.modelId ? `${base}?model=${encodeURIComponent(input.modelId)}` : base;
  const props = await fetchJson(queryUrl, input.signal, input.fetchImpl);
  if (props) return props;
  if (queryUrl !== base) return await fetchJson(base, input.signal, input.fetchImpl);
  return null;
}

function discoveredModelFromApi(input: {
  model: Record<string, any>;
  props: Record<string, any> | null;
  serverUrl: string;
  apiBaseUrl: string;
  apiType: LocalModelApiType;
  platform: LocalModelPlatform;
}): DiscoveredLocalModel | null {
  const rawId = typeof input.model.id === "string"
    ? input.model.id
    : typeof input.model.name === "string"
      ? input.model.name
      : typeof input.model.model === "string"
        ? input.model.model
        : "";
  if (!rawId.trim()) return null;
  const modelId = safeLocalModelId(rawId);
  const contextWindowTokens = contextFromProps(input.props) ??
    contextFromModel(input.model) ??
    DEFAULT_LOCAL_CONTEXT_WINDOW_TOKENS;
  const maxOutputTokens = Math.min(DEFAULT_LOCAL_MAX_OUTPUT_TOKENS, contextWindowTokens);
  return {
    provider_id: "local",
    provider_label: "Local",
    model_id: modelId,
    model_ref: `local/${modelId}`,
    display_name: displayNameForModelId(modelId),
    api_type: input.apiType,
    platform: input.platform,
    server_url: input.serverUrl,
    api_base_url: input.apiBaseUrl,
    context_window_tokens: contextWindowTokens,
    max_output_tokens: maxOutputTokens,
    reasoning_budget_ratio: undefined,
    token_estimator: "character_estimate",
    source: "discovered",
    source_url: LOCAL_MODEL_SOURCE_URL,
    runtime_supported: true,
  };
}

export async function discoverLocalModels(input: LocalModelDiscoveryInput): Promise<LocalModelDiscoveryResult> {
  const apiType = normalizeApiType(input.apiType);
  const platform = normalizeLocalModelPlatform(input.platform);
  const server = normalizeLocalServerUrl(input.serverUrl);
  const serverRoot = localServerRootFromApiBase(server.apiBaseUrl);
  const modelsResponse = await fetchJson(`${server.apiBaseUrl}/models`, input.signal, input.fetchImpl);
  const rawModels = Array.isArray(modelsResponse?.data)
    ? modelsResponse.data
    : Array.isArray(modelsResponse?.models)
      ? modelsResponse.models
      : [];
  if (rawModels.length === 0) {
    throw new Error("Local model server did not return any models from /v1/models.");
  }

  const output: DiscoveredLocalModel[] = [];
  for (const rawModel of rawModels) {
    if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) continue;
    const rawId = typeof rawModel.id === "string" ? rawModel.id : typeof rawModel.model === "string" ? rawModel.model : "";
    const props = await fetchProps({
      serverRoot,
      modelId: rawId,
      signal: input.signal,
      fetchImpl: input.fetchImpl,
    });
    const discovered = discoveredModelFromApi({
      model: rawModel as Record<string, any>,
      props,
      serverUrl: server.serverUrl,
      apiBaseUrl: server.apiBaseUrl,
      apiType,
      platform,
    });
    if (discovered) output.push(discovered);
  }

  if (output.length === 0) {
    throw new Error("Local model discovery returned only unsupported model records.");
  }
  return {
    server_url: server.serverUrl,
    api_base_url: server.apiBaseUrl,
    api_type: apiType,
    platform,
    models: output,
  };
}
