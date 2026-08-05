import { getButlerData, readConfig } from "./runtime-support.ts";
import { parseModelRef } from "../model-ref.ts";
import { readLocalModelConfigs, type LocalModelConfig } from "../local/models.ts";
import { readRegisteredHostedModelConfigs, resolveProviderCredentialSecret, type HostedModelProviderId, type RegisteredHostedModelConfig } from "./registered-models.ts";
import {
  resolveModelMetadata,
  type HostedProviderApiShape,
  type ModelProviderId,
} from "../model-catalog.ts";
import { resolveOpenAICodexAuth } from "../openai/auth.ts";
import { DEFAULT_CODEX_MODEL } from "../openai/models.ts";
import { type OpenAIAuthOverride } from "../runtime-contracts.ts";


export interface HostedRuntimeConfig {
  providerId: HostedModelProviderId;
  modelId: string;
  modelRef: `${HostedModelProviderId}/${string}`;
  authType: "api_key" | "codex_oauth";
  apiKey?: string;
  apiBaseUrl?: string;
  apiShape?: HostedProviderApiShape;
}


export function configuredDefaultModelRef(): string | null {
  const cfg = readConfig();
  const value = cfg?.system?.butlerModel ?? cfg?.system?.defaultModel;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveEffectiveModelRef(model?: string): string {
  return model?.trim() || configuredDefaultModelRef() || `openai/${DEFAULT_CODEX_MODEL}`;
}


export function isLocalModelRequest(model?: string): boolean {
  const requested = model?.trim() || configuredDefaultModelRef();
  return requested ? parseModelRef(requested).providerId === "local" : false;
}


export function resolveLocalModelConfig(model?: string): LocalModelConfig {
  const requested = model?.trim() || configuredDefaultModelRef() || "";
  const parsed = parseModelRef(requested);
  const configs = readLocalModelConfigs(getButlerData());
  const match = configs.find((config) =>
    config.model_ref === parsed.canonicalRef ||
    config.model_id === parsed.modelId ||
    (!requested && config.runtime_supported),
  );
  if (!match) {
    throw new Error(`Local model is not registered: ${model || "local"}`);
  }
  if (match.api_type !== "openai_compatible") {
    throw new Error(`Unsupported local model API type: ${match.api_type}`);
  }
  return match;
}


export function hostedProviderId(value: string): HostedModelProviderId | null {
  if (
    value === "openai" ||
    value === "anthropic" ||
    value === "google" ||
    value === "xai" ||
    value === "qwen" ||
    value === "kimi" ||
    value === "zai" ||
    value === "zai-api" ||
    value === "opencode-go"
  ) return value;
  return null;
}


export function resolveRegisteredHostedModelConfig(model?: string): RegisteredHostedModelConfig | null {
  const requested = model?.trim() || configuredDefaultModelRef() || "";
  if (!requested) return null;
  const parsed = parseModelRef(requested);
  const providerId = hostedProviderId(parsed.providerId);
  if (!providerId) return null;
  const configs = readRegisteredHostedModelConfigs(getButlerData());
  const match = configs.find((config) =>
    config.provider_id === providerId &&
    (config.model_ref === parsed.canonicalRef || config.model_id === parsed.modelId),
  );
  if (match) return match;
  if (providerId === "openai") return null;
  throw new Error(`Hosted model is not registered: ${parsed.canonicalRef}`);
}


export function resolveHostedRuntimeConfig(model?: string): HostedRuntimeConfig | null {
  const registered = resolveRegisteredHostedModelConfig(model);
  if (!registered) return null;
  const metadata = resolveModelMetadata(registered.model_ref);
  if (registered.auth_type === "codex_oauth") {
    return {
      providerId: registered.provider_id,
      modelId: registered.model_id,
      modelRef: registered.model_ref,
      authType: "codex_oauth",
      apiBaseUrl: registered.api_base_url,
      apiShape: metadata.hosted_api_shape,
    };
  }
  const apiKey = resolveProviderCredentialSecret(
    registered.credential_id,
    registered.provider_id,
    getButlerData(),
  );
  if (!apiKey) {
    throw new Error(`Provider API key credential is not registered for ${registered.model_ref}`);
  }
  return {
    providerId: registered.provider_id,
    modelId: registered.model_id,
    modelRef: registered.model_ref,
    authType: "api_key",
    apiKey,
    apiBaseUrl: registered.api_base_url,
    apiShape: metadata.hosted_api_shape,
  };
}

export function requireHostedRuntimeConfig(
  model: string | undefined,
  providerId: Exclude<ModelProviderId, "local">,
): HostedRuntimeConfig {
  const config = resolveHostedRuntimeConfig(model);
  if (!config || config.providerId !== providerId) {
    throw new Error(`hosted_provider_config_mismatch:${providerId}:${model ?? "default"}`);
  }
  return config;
}


export async function openAIAuthOverrideForHosted(config: HostedRuntimeConfig): Promise<OpenAIAuthOverride | undefined> {
  if (config.providerId !== "openai") return undefined;
  if (config.authType === "api_key" && config.apiKey) {
    return {
      mode: "api_key",
      authorization: `Bearer ${config.apiKey}`,
    };
  }
  return await resolveOpenAICodexAuth();
}
