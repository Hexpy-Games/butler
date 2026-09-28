import { api, apiErrorCode } from "./api.ts";
import { appCopy } from "./copy.ts";
import { normalizeReadiness, type SetupReadinessView } from "./setupReadiness.ts";
import type { FirstRunProviderCardId, LocalModelOption, LocalModelServerView } from "./setupProviders.ts";
import type {
  AppModelSummary,
  HostedModelRegistrationResult,
  LocalModelRegistrationResult,
  ModelCatalogView,
  OnboardingSettingsView,
  ReasoningEffort,
  SettingsView,
} from "./types.ts";

// #230 endpoints, served by the Rust agent (#279); these are the app's only callers.

/** Agent readiness, or `unsupported` when the agent predates #230. */
export async function fetchSetupReadiness(): Promise<SetupReadinessView | "unsupported"> {
  try {
    return normalizeReadiness(await api<unknown>("/setup/readiness")) ?? { status: "preparing", steps: [] };
  } catch (error) {
    if (isMissingRoute(error)) return "unsupported";
    throw error;
  }
}

/** Runs the agent's preparation again after a failure; answers the new (preparing) view. */
export async function retrySetupReadiness(): Promise<SetupReadinessView> {
  const view = normalizeReadiness(await api<unknown>("/setup/readiness/retry", { method: "POST", body: JSON.stringify({}) }));
  return view ?? { status: "preparing", steps: [] };
}

/** Probes Ollama (:11434) and LM Studio (:1234) with a short timeout. */
export async function fetchLocalModelServers(): Promise<LocalModelServerView[]> {
  const result = await api<{ servers?: LocalModelServerView[] }>("/setup/local-model-servers");
  return Array.isArray(result?.servers) ? result.servers : [];
}

/**
 * Checks a key with the service without saving it; throws with `error.code`
 * on failure. `verified: false` means the service has no model list to check
 * the key against (the key is still usable).
 */
export async function verifyApiKey(providerId: string, apiKey: string): Promise<{ verified: boolean }> {
  const result = await api<{ valid?: boolean; verified?: boolean }>("/setup/credentials/verify", {
    method: "POST",
    body: JSON.stringify({ provider_id: providerId, api_key: apiKey }),
  });
  return { verified: result?.verified !== false };
}

/**
 * Saves a key (the agent names it `openai`, `openai-2`, ...). The same key
 * again answers the existing credential with `created: false`; either way the
 * id is what the model registers with.
 */
export async function saveApiKey(providerId: string, apiKey: string): Promise<{ id: string; created: boolean }> {
  const result = await api<{ credential?: { id?: string }; created?: boolean }>("/credentials", {
    method: "POST",
    body: JSON.stringify({ provider_id: providerId, api_key: apiKey }),
  });
  const id = result?.credential?.id;
  if (!id) throw Object.assign(new Error("credential_missing"), { code: "credential_missing" });
  return { id, created: result?.created !== false };
}

/** A route an older agent does not serve (404 or a desktop bridge without the method). */
export function isMissingRoute(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  const code = apiErrorCode(error);
  return status === 404 || code === "not_found" || code === "route_not_found" ||
    (error instanceof Error && /bridge is missing|Unsupported Butler app API route/u.test(error.message));
}

export type KeyCheckFailure = "invalid" | "noaccess" | "network" | "ratelimited" | "unavailable" | "unsupported" | "badrequest";

const KEY_CHECK_FAILURES: Record<string, KeyCheckFailure> = {
  invalid_key: "invalid",
  no_access: "noaccess",
  network: "network",
  rate_limited: "ratelimited",
  provider_unavailable: "unavailable",
  unsupported_provider: "unsupported",
  invalid_request: "badrequest",
};

/** #279 key check codes; anything else (or no code) reads as "the service isn't responding". */
export function keyCheckFailure(code: string | undefined): KeyCheckFailure {
  return (code && KEY_CHECK_FAILURES[code]) || "unavailable";
}

export interface RoutinePreset {
  model: AppModelSummary;
  modelId: string;
  modelRef: string;
  effort: ReasoningEffort;
}

const EVERYDAY_EFFORTS: readonly ReasoningEffort[] = ["medium", "low", "high", "none"];

/**
 * The provider's everyday default model. In order: the catalog's
 * `presets.routine` (catalog #278), the worker `routine_work` preset (the
 * catalog before #278), then the provider's recommended or latest model at
 * medium effort (the lowest step above none when medium is missing), never
 * xhigh or max.
 */
export function routinePreset(catalog: ModelCatalogView, providerId: string): RoutinePreset | null {
  const provider = catalog.providers.find((entry) => entry.provider_id === providerId);
  if (!provider) return null;
  const findModel = (ref: string) => provider.models.find((entry) => entry.model_ref === ref || entry.model_id === ref);
  const worker = catalog.worker_model_presets.find((entry) => entry.provider_id === providerId)?.routine_work;
  for (const preset of [provider.presets?.routine, worker && { model: worker.model, effort: worker.reasoning_effort }]) {
    const model = preset ? findModel(preset.model) : undefined;
    if (preset && model) return { model, modelId: model.model_id, modelRef: model.model_ref, effort: preset.effort };
  }
  const model = provider.models.find((entry) => entry.status === "recommended") ?? findModel(provider.latest_model_ref) ?? provider.models[0];
  if (!model) return null;
  const effort = EVERYDAY_EFFORTS.find((candidate) => model.reasoning_efforts.includes(candidate)) ?? "medium";
  return { model, modelId: model.model_id, modelRef: model.model_ref, effort };
}

type DefaultModelPatch = Pick<SettingsView, "model" | "reasoning_effort" | "context_window_tokens" | "worker_profiles">;

/** Chat model, effort and every worker profile on the connected model. */
export function defaultModelSettingsPatch(settings: SettingsView, model: AppModelSummary, effort: ReasoningEffort): DefaultModelPatch {
  const profiles: SettingsView["worker_profiles"] = settings.worker_profiles.length > 0 ? settings.worker_profiles : [{
    id: "default", label: appCopy.interfaceDetails.default, enabled: true,
    job: { kind: "builtin", job: "coding" }, model: model.model_ref, reasoning_effort: effort,
  }];
  return {
    model: model.model_ref,
    reasoning_effort: effort,
    context_window_tokens: model.context_window_tokens ?? settings.context_window_tokens,
    worker_profiles: profiles.map((profile) => ({ ...profile, model: model.model_ref, reasoning_effort: effort })),
  };
}

export type PendingConnection =
  | { kind: "hosted"; cardId: FirstRunProviderCardId; providerId: string; authType: "api_key" | "codex_oauth"; credentialId?: string }
  | { kind: "local"; cardId: FirstRunProviderCardId; option: LocalModelOption; apiKey?: string };

const DEFAULT_LOCAL_CONTEXT_TOKENS = 16_384;

async function registerConnectionModel(connection: PendingConnection): Promise<{ model: AppModelSummary; effort: ReasoningEffort; catalog: ModelCatalogView }> {
  if (connection.kind === "local") {
    const { option } = connection;
    const result = await api<LocalModelRegistrationResult>("/model-catalog/local-models", {
      method: "POST",
      body: JSON.stringify({
        provider_id: "local", api_type: "openai_compatible", platform: option.platform, server_url: option.serverUrl,
        model_id: option.modelId, display_name: option.sourceModel?.display_name ?? option.modelId,
        context_window_tokens: option.contextWindowTokens ?? DEFAULT_LOCAL_CONTEXT_TOKENS,
        max_output_tokens: option.sourceModel?.max_output_tokens, source: "discovered",
        ...(connection.apiKey ? { api_key: connection.apiKey } : {}),
      }),
    });
    return { model: result.model, effort: result.model.default_reasoning_effort, catalog: result.catalog };
  }
  const preset = routinePreset(await api<ModelCatalogView>("/model-catalog"), connection.providerId);
  if (!preset) throw Object.assign(new Error("no_usable_model"), { code: "no_usable_model" });
  const result = await api<HostedModelRegistrationResult>("/model-catalog/registered-models", {
    method: "POST",
    body: JSON.stringify({
      provider_id: connection.providerId, model_id: preset.modelId, auth_type: connection.authType,
      ...(connection.credentialId ? { credential_id: connection.credentialId } : {}),
    }),
  });
  return { model: result.model, effort: preset.effort, catalog: result.catalog };
}

/**
 * Registers the chosen model, then makes it the default and records
 * onboarding in one settings PATCH. `onboarding` receives the agent's current
 * onboarding state and returns the state to save.
 */
export async function commitConnection({ connection, language, onboarding }: {
  connection: PendingConnection;
  language: SettingsView["language"];
  onboarding: (current: OnboardingSettingsView | undefined) => OnboardingSettingsView;
}): Promise<{ settings: SettingsView; catalog: ModelCatalogView; model: AppModelSummary }> {
  const settings = await api<SettingsView>("/settings");
  const { model, effort, catalog } = await registerConnectionModel(connection);
  // An agent before #230 has no `onboarding` setting and rejects unknown fields.
  const patch = {
    language,
    ...defaultModelSettingsPatch(settings, model, effort),
    ...(settings.onboarding ? { onboarding: onboarding(settings.onboarding) } : {}),
  };
  const saved = await api<Partial<SettingsView>>("/settings", { method: "PATCH", body: JSON.stringify(patch) });
  return { settings: { ...settings, ...patch, ...saved, language }, catalog, model };
}
