import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  listModelMetadata,
  defaultHostedProviderApiBaseUrl,
  type ModelProviderId,
  type ProviderAuthMethod,
  type ProviderModelMetadata,
} from "../model-catalog.ts";

export type HostedModelProviderId = Exclude<ModelProviderId, "local">;

export interface ProviderCredentialRecord {
  id: string;
  provider_id: HostedModelProviderId;
  auth_type: ProviderAuthMethod;
  label: string;
  secret: string;
  created_at: string;
  updated_at: string;
}

export interface ProviderCredentialView {
  id: string;
  provider_id: HostedModelProviderId;
  auth_type: ProviderAuthMethod;
  label: string;
  masked_value: string;
  created_at: string;
  updated_at: string;
}

export interface RegisteredHostedModelConfig {
  provider_id: HostedModelProviderId;
  provider_label: string;
  model_id: string;
  model_ref: `${HostedModelProviderId}/${string}`;
  display_name: string;
  auth_type: ProviderAuthMethod;
  credential_id?: string;
  api_base_url?: string;
  created_at: string;
  updated_at: string;
}

export interface HostedModelRegistrationInput {
  providerId: HostedModelProviderId;
  modelId: string;
  displayName?: string;
  authType: ProviderAuthMethod;
  credentialId?: string;
  apiKey?: string;
  credentialLabel?: string;
  apiBaseUrl?: string;
}

interface ButlerConfig {
  models?: {
    registered?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface CredentialStoreFile {
  credentials?: unknown;
}

function defaultButlerData(): string {
  return process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function configPath(butlerData = defaultButlerData()): string {
  return join(butlerData, "butler.config.json");
}

function credentialStorePath(butlerData = defaultButlerData()): string {
  return join(butlerData, "auth", "model-provider-credentials.json");
}

function readJsonObject<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as T
      : null;
  } catch {
    return null;
  }
}

function writeJsonObject(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmpPath, path);
}

function readButlerConfig(butlerData = defaultButlerData()): ButlerConfig {
  return readJsonObject<ButlerConfig>(configPath(butlerData)) ?? {};
}

function writeButlerConfig(config: ButlerConfig, butlerData = defaultButlerData()): void {
  writeJsonObject(configPath(butlerData), config);
}

function hostedProviderId(value: unknown): HostedModelProviderId | null {
  if (
    value === "openai" ||
    value === "anthropic" ||
    value === "google" ||
    value === "xai" ||
    value === "qwen" ||
    value === "kimi" ||
    value === "zai" ||
    value === "opencode-go"
  ) return value;
  return null;
}

function providerAuthMethod(value: unknown): ProviderAuthMethod | null {
  return value === "api_key" || value === "codex_oauth" ? value : null;
}

function safeLabel(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  if (!text) return fallback;
  return text.length > 80 ? text.slice(0, 79).trimEnd() : text;
}

function normalizeHostedApiBaseUrl(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return text.replace(/\/+$/u, "");
  } catch {
    return undefined;
  }
}

function normalizeCredential(value: unknown): ProviderCredentialRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Partial<ProviderCredentialRecord>;
  const providerId = hostedProviderId(input.provider_id);
  const authType = providerAuthMethod(input.auth_type);
  const secret = typeof input.secret === "string" ? input.secret.trim() : "";
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!providerId || authType !== "api_key" || !secret || !id) return null;
  const now = new Date().toISOString();
  return {
    id,
    provider_id: providerId,
    auth_type: authType,
    label: safeLabel(input.label, providerLabel(providerId)),
    secret,
    created_at: typeof input.created_at === "string" ? input.created_at : now,
    updated_at: typeof input.updated_at === "string" ? input.updated_at : now,
  };
}

function readCredentialRecords(butlerData = defaultButlerData()): ProviderCredentialRecord[] {
  const raw = readJsonObject<CredentialStoreFile>(credentialStorePath(butlerData));
  const items = Array.isArray(raw?.credentials) ? raw.credentials : [];
  const seen = new Set<string>();
  const records: ProviderCredentialRecord[] = [];
  for (const item of items) {
    const credential = normalizeCredential(item);
    if (!credential || seen.has(credential.id)) continue;
    seen.add(credential.id);
    records.push(credential);
  }
  return records;
}

function writeCredentialRecords(records: ProviderCredentialRecord[], butlerData = defaultButlerData()): void {
  writeJsonObject(credentialStorePath(butlerData), { credentials: records });
}

export function maskedCredentialValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const prefix = trimmed.slice(0, 3);
  const suffix = trimmed.slice(-1);
  return `${prefix}...${suffix}`;
}

export function credentialView(record: ProviderCredentialRecord): ProviderCredentialView {
  return {
    id: record.id,
    provider_id: record.provider_id,
    auth_type: record.auth_type,
    label: record.label,
    masked_value: maskedCredentialValue(record.secret),
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

export function listProviderCredentialViews(butlerData = defaultButlerData()): ProviderCredentialView[] {
  return readCredentialRecords(butlerData).map(credentialView);
}

export function upsertProviderApiKeyCredential(
  input: {
    providerId: HostedModelProviderId;
    apiKey: string;
    label?: string;
    credentialId?: string;
  },
  butlerData = defaultButlerData(),
): ProviderCredentialRecord {
  const value = input.apiKey.trim();
  if (!value) throw new Error("Provider API key is required.");
  const now = new Date().toISOString();
  const records = readCredentialRecords(butlerData);
  const existingIndex = input.credentialId
    ? records.findIndex((record) => record.id === input.credentialId)
    : -1;
  const previous = existingIndex >= 0 ? records[existingIndex] : null;
  if (previous && previous.provider_id !== input.providerId) {
    throw new Error("Credential provider does not match the selected provider.");
  }
  const next: ProviderCredentialRecord = {
    id: previous?.id ?? `cred_${randomUUID()}`,
    provider_id: input.providerId,
    auth_type: "api_key",
    label: safeLabel(input.label, previous?.label ?? providerLabel(input.providerId)),
    secret: value,
    created_at: previous?.created_at ?? now,
    updated_at: now,
  };
  if (existingIndex >= 0) records[existingIndex] = next;
  else records.push(next);
  writeCredentialRecords(records, butlerData);
  return next;
}

export function resolveProviderCredentialSecret(
  credentialId: string | undefined,
  providerId: HostedModelProviderId,
  butlerData = defaultButlerData(),
): string | null {
  if (!credentialId) return null;
  const record = readCredentialRecords(butlerData).find((candidate) =>
    candidate.id === credentialId &&
    candidate.provider_id === providerId &&
    candidate.auth_type === "api_key",
  );
  return record?.secret ?? null;
}

function providerLabel(providerId: HostedModelProviderId): string {
  return listModelMetadata().find((model) => model.provider_id === providerId)
    ?.provider_label ?? providerId;
}

function modelForRegistration(providerId: HostedModelProviderId, modelIdOrRef: string): ProviderModelMetadata | null {
  const value = modelIdOrRef.trim();
  if (!value) return null;
  return listModelMetadata().find((model) =>
    model.provider_id === providerId &&
    (model.model_id === value || model.model_ref === value),
  ) ?? null;
}

function normalizeRegisteredModel(value: unknown): RegisteredHostedModelConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Partial<RegisteredHostedModelConfig>;
  const providerId = hostedProviderId(input.provider_id);
  const authType = providerAuthMethod(input.auth_type);
  if (!providerId || !authType) return null;
  if (authType === "codex_oauth" && providerId !== "openai") return null;
  const base = modelForRegistration(providerId, String(input.model_id ?? input.model_ref ?? ""));
  if (!base) return null;
  const credentialId = typeof input.credential_id === "string" && input.credential_id.trim()
    ? input.credential_id.trim()
    : undefined;
  if (authType === "api_key" && !credentialId) return null;
  const apiBaseUrl = normalizeHostedApiBaseUrl(input.api_base_url);
  const now = new Date().toISOString();
  return {
    provider_id: providerId,
    provider_label: base.provider_label,
    model_id: base.model_id,
    model_ref: base.model_ref as `${HostedModelProviderId}/${string}`,
    display_name: safeLabel(input.display_name, base.display_name),
    auth_type: authType,
    ...(credentialId ? { credential_id: credentialId } : {}),
    ...(apiBaseUrl ? { api_base_url: apiBaseUrl } : {}),
    created_at: typeof input.created_at === "string" ? input.created_at : now,
    updated_at: typeof input.updated_at === "string" ? input.updated_at : now,
  };
}

export function readRegisteredHostedModelConfigs(
  butlerData = defaultButlerData(),
): RegisteredHostedModelConfig[] {
  const config = readButlerConfig(butlerData);
  const raw = Array.isArray(config.models?.registered) ? config.models.registered : [];
  const seen = new Set<string>();
  const models: RegisteredHostedModelConfig[] = [];
  for (const item of raw) {
    const model = normalizeRegisteredModel(item);
    if (!model || seen.has(model.model_ref)) continue;
    seen.add(model.model_ref);
    models.push(model);
  }
  return models;
}

function writeRegisteredHostedModelConfigs(
  models: RegisteredHostedModelConfig[],
  butlerData = defaultButlerData(),
): void {
  const config = readButlerConfig(butlerData);
  writeButlerConfig({
    ...config,
    models: {
      ...(config.models && typeof config.models === "object" ? config.models : {}),
      registered: models,
    },
  }, butlerData);
}

export function registerHostedModelConfig(
  input: HostedModelRegistrationInput,
  butlerData = defaultButlerData(),
): RegisteredHostedModelConfig {
  const base = modelForRegistration(input.providerId, input.modelId);
  if (!base) throw new Error("Provider model is not available for registration.");
  if (input.authType === "codex_oauth" && input.providerId !== "openai") {
    throw new Error("Browser OAuth is only supported for OpenAI Codex auth.");
  }
  let credentialId = input.credentialId?.trim() || undefined;
  if (input.authType === "api_key") {
    if (!credentialId) {
      const credential = upsertProviderApiKeyCredential({
        providerId: input.providerId,
        apiKey: input.apiKey ?? "",
        label: input.credentialLabel,
      }, butlerData);
      credentialId = credential.id;
    }
    const secret = resolveProviderCredentialSecret(credentialId, input.providerId, butlerData);
    if (!secret) throw new Error("Provider API key credential is not registered.");
  }
  const now = new Date().toISOString();
  const apiBaseUrl = normalizeHostedApiBaseUrl(input.apiBaseUrl);
  if (input.apiBaseUrl?.trim() && !apiBaseUrl) {
    throw new Error("Provider API base URL must be a valid http(s) URL.");
  }
  const existing = readRegisteredHostedModelConfigs(butlerData);
  const previous = existing.find((model) => model.model_ref === base.model_ref);
  const next = existing.filter((model) => model.model_ref !== base.model_ref);
  const model: RegisteredHostedModelConfig = {
    provider_id: input.providerId,
    provider_label: base.provider_label,
    model_id: base.model_id,
    model_ref: base.model_ref as `${HostedModelProviderId}/${string}`,
    display_name: safeLabel(input.displayName, base.display_name),
    auth_type: input.authType,
    ...(credentialId ? { credential_id: credentialId } : {}),
    ...(apiBaseUrl ? { api_base_url: apiBaseUrl } : {}),
    created_at: previous?.created_at ?? now,
    updated_at: now,
  };
  next.push(model);
  writeRegisteredHostedModelConfigs(next, butlerData);
  return model;
}

export function deleteHostedModelConfig(
  lookup: string,
  butlerData = defaultButlerData(),
): RegisteredHostedModelConfig {
  const existing = readRegisteredHostedModelConfigs(butlerData);
  const value = lookup.trim();
  const previous = existing.find((model) => model.model_ref === value || model.model_id === value);
  if (!previous) throw new Error("Hosted model is not registered.");
  writeRegisteredHostedModelConfigs(
    existing.filter((model) => model.model_ref !== previous.model_ref),
    butlerData,
  );
  return previous;
}

export function registeredHostedModelMetadata(
  butlerData = defaultButlerData(),
): ProviderModelMetadata[] {
  const credentials = new Map(readCredentialRecords(butlerData).map((record) => [record.id, record]));
  return readRegisteredHostedModelConfigs(butlerData).flatMap((model) => {
    const base = modelForRegistration(model.provider_id, model.model_ref);
    if (!base) return [];
    const credential = model.credential_id ? credentials.get(model.credential_id) : undefined;
    return [{
      ...base,
      display_name: model.display_name || base.display_name,
      registered: true,
      auth_type: model.auth_type,
      credential_id: model.credential_id,
      credential_label: credential?.label,
      credential_masked_value: credential ? maskedCredentialValue(credential.secret) : undefined,
      api_base_url: model.api_base_url ?? defaultHostedProviderApiBaseUrl(model.provider_id),
      runtime_supported: true,
      reasoning_efforts: [...base.reasoning_efforts],
    }];
  });
}
