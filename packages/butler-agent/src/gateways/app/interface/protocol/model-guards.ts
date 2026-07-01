import type { HostedModelRegistrationRequest, LocalModelDiscoveryRequest, LocalModelRegistrationRequest, LocalModelUpdateRequest, ProviderAuthMethod, ProviderCredentialUpsertRequest } from "./integration-contract.ts";

function isLocalModelPlatform(
  value: unknown,
): value is LocalModelDiscoveryRequest["platform"] {
  return (
    value === "llama_cpp" ||
    value === "ollama" ||
    value === "lm_studio" ||
    value === "custom"
  );
}

export function isLocalModelDiscoveryRequest(
  value: unknown,
): value is LocalModelDiscoveryRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<LocalModelDiscoveryRequest>;
  return (
    input.provider_id === "local" &&
    input.api_type === "openai_compatible" &&
    isLocalModelPlatform(input.platform) &&
    typeof input.server_url === "string" &&
    input.server_url.trim().length > 0
  );
}

export function isLocalModelRegistrationRequest(
  value: unknown,
): value is LocalModelRegistrationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<LocalModelRegistrationRequest>;
  return (
    input.provider_id === "local" &&
    input.api_type === "openai_compatible" &&
    isLocalModelPlatform(input.platform) &&
    typeof input.server_url === "string" &&
    input.server_url.trim().length > 0 &&
    typeof input.model_id === "string" &&
    input.model_id.trim().length > 0 &&
    typeof input.context_window_tokens === "number" &&
    Number.isFinite(input.context_window_tokens) &&
    input.context_window_tokens > 0 &&
    (input.max_output_tokens === undefined ||
      (typeof input.max_output_tokens === "number" &&
        Number.isFinite(input.max_output_tokens) &&
        input.max_output_tokens > 0)) &&
    (input.reasoning_budget_ratio === undefined ||
      (typeof input.reasoning_budget_ratio === "number" &&
        Number.isFinite(input.reasoning_budget_ratio) &&
        input.reasoning_budget_ratio >= 0 &&
        input.reasoning_budget_ratio <= 1)) &&
    (input.display_name === undefined ||
      typeof input.display_name === "string") &&
    (input.source === undefined ||
      input.source === "discovered" ||
      input.source === "manual")
  );
}

export function isLocalModelUpdateRequest(
  value: unknown,
): value is LocalModelUpdateRequest {
  return isLocalModelRegistrationRequest(value);
}

function isHostedProviderId(
  value: unknown,
): value is HostedModelRegistrationRequest["provider_id"] {
  return (
    value === "openai" ||
    value === "anthropic" ||
    value === "google" ||
    value === "xai" ||
    value === "qwen" ||
    value === "kimi" ||
    value === "zai" ||
    value === "opencode-go"
  );
}

function isProviderAuthMethod(value: unknown): value is ProviderAuthMethod {
  return value === "api_key" || value === "codex_oauth";
}

export function isProviderCredentialUpsertRequest(
  value: unknown,
): value is ProviderCredentialUpsertRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<ProviderCredentialUpsertRequest>;
  return (
    isHostedProviderId(input.provider_id) &&
    input.auth_type === "api_key" &&
    typeof input.api_key === "string" &&
    input.api_key.trim().length > 0 &&
    (input.label === undefined || typeof input.label === "string") &&
    (input.credential_id === undefined ||
      typeof input.credential_id === "string")
  );
}

export function isHostedModelRegistrationRequest(
  value: unknown,
): value is HostedModelRegistrationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<HostedModelRegistrationRequest>;
  if (!isHostedProviderId(input.provider_id)) return false;
  if (
    typeof input.model_id !== "string" ||
    input.model_id.trim().length === 0
  ) {
    return false;
  }
  if (!isProviderAuthMethod(input.auth_type)) return false;
  if (input.auth_type === "codex_oauth" && input.provider_id !== "openai") {
    return false;
  }
  if (input.auth_type === "api_key") {
    const hasCredential =
      typeof input.credential_id === "string" &&
      input.credential_id.trim().length > 0;
    const hasApiKey =
      typeof input.api_key === "string" && input.api_key.trim().length > 0;
    if (!hasCredential && !hasApiKey) return false;
  }
  return (
    (input.display_name === undefined ||
      typeof input.display_name === "string") &&
    (input.credential_id === undefined ||
      typeof input.credential_id === "string") &&
    (input.api_key === undefined || typeof input.api_key === "string") &&
    (input.credential_label === undefined ||
      typeof input.credential_label === "string") &&
    (input.api_base_url === undefined ||
      typeof input.api_base_url === "string")
  );
}
