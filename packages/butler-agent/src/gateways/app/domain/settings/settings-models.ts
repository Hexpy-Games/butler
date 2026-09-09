import {
  DEFAULT_MODEL_REF,
  findModelMetadata,
  listModelMetadata,
  modelIdentityKey,
  resolveRegisteredRuntimeModelMetadata,
  type ProviderModelMetadata,
} from "../../../../integrations/providers/model-catalog.ts";
import { PROFILE_EXTRACTOR_MODEL_DEFAULT } from "../../../../personalization/profiling.ts";
import type {
  ModelFallbackSettingsUpdate,
  ModelFallbackSettingsView,
  SessionControlState,
  SettingsView,
} from "../../interface/protocol/app-protocol.ts";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 258_000;
export const MAX_MODEL_FALLBACK_MODELS = 5;
export const DEFAULT_MODEL_FALLBACK_SETTINGS: ModelFallbackSettingsView = {
  enabled: false,
  models: [],
};

export function normalizeModelFallbackSettings(
  input: ModelFallbackSettingsUpdate | ModelFallbackSettingsView | undefined,
  primaryModelRef: string,
  registeredModels: ProviderModelMetadata[] = [],
): ModelFallbackSettingsView {
  const enabled = input?.enabled === true;
  const primary = findModelMetadata(primaryModelRef, allKnownModels(registeredModels));
  const seenIdentities = new Set<string>();
  if (primary) seenIdentities.add(modelIdentityKey(primary));

  const selectableByRef = new Map<string, ProviderModelMetadata>(
    registeredModels
      .filter(
        (model) =>
          model.runtime_supported === true &&
          model.registered !== false &&
          model.enabled !== false,
      )
      .map((model) => [model.model_ref, model] as const),
  );
  const models: string[] = [];
  const requestedModels = Array.isArray(input?.models) ? input.models : [];
  for (const requested of requestedModels) {
    if (typeof requested !== "string") continue;
    const normalizedRef = normalizeKnownModelRef(requested, registeredModels);
    const model = normalizedRef ? selectableByRef.get(normalizedRef) : undefined;
    if (!model) continue;
    const identity = modelIdentityKey(model);
    if (seenIdentities.has(identity)) continue;
    seenIdentities.add(identity);
    models.push(model.model_ref);
    if (models.length >= MAX_MODEL_FALLBACK_MODELS) break;
  }
  return { enabled, models };
}

function allKnownModels(
  registeredModels: ProviderModelMetadata[],
): ProviderModelMetadata[] {
  const byRef = new Map<string, ProviderModelMetadata>();
  for (const model of listModelMetadata(registeredModels)) {
    byRef.set(model.model_ref, model);
  }
  return [...byRef.values()];
}

export function rewriteSettingsModelRefs(
  input: Partial<SettingsView>,
  previousModelRef: string,
  nextModelRef: string,
): Partial<SettingsView> {
  const source = input as Partial<SettingsView> & {
    worker_model_rules?: unknown;
  };
  const { worker_model_rules: _legacyWorkerModelRules, ...canonical } = source;
  return {
    ...canonical,
    model: canonical.model === previousModelRef ? nextModelRef : canonical.model,
    consolidation_model:
      canonical.consolidation_model === previousModelRef
        ? nextModelRef
        : canonical.consolidation_model,
    worker_profiles: Array.isArray(canonical.worker_profiles)
      ? canonical.worker_profiles.map((profile) => ({
          ...profile,
          model:
            profile.model === previousModelRef ? nextModelRef : profile.model,
        }))
      : canonical.worker_profiles,
  };
}

export function clampContextWindowTokens(
  input: unknown,
  modelMaxTokens: number,
): number {
  const modelMax = positiveTokenCount(modelMaxTokens) ?? 200_000;
  const fallback = Math.min(DEFAULT_CONTEXT_WINDOW_TOKENS, modelMax);
  const value = positiveTokenCount(input) ?? fallback;
  return Math.max(1_000, Math.min(value, modelMax));
}

export function contextWindowTokensForSessionModel(
  settings: Pick<SettingsView, "model" | "context_window_tokens">,
  metadata: ProviderModelMetadata,
): number {
  const configuredForSelectedModel = settings.model === metadata.model_ref;
  return clampContextWindowTokens(
    configuredForSelectedModel ? settings.context_window_tokens : undefined,
    metadata.context_window_tokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
  );
}

export function normalizeKnownModelRef(
  input: string,
  extraModels: ProviderModelMetadata[] = [],
): string | undefined {
  const value = input.trim();
  if (!value) return undefined;
  const models = extraModels.length > 0 ? extraModels : listModelMetadata();
  const match = findModelMetadata(value, models);
  if (!match || !match.runtime_supported || match.registered === false || match.enabled === false) {
    return undefined;
  }
  return match?.model_ref;
}

export function normalizeConsolidationModelRef(
  input: string,
  extraModels: ProviderModelMetadata[] = [],
): string | undefined {
  const value = input.trim();
  if (!value) return undefined;
  if (value === PROFILE_EXTRACTOR_MODEL_DEFAULT) return value;
  return normalizeKnownModelRef(value, extraModels);
}

export function normalizeSessionControls(
  input: Partial<SessionControlState>,
  extraModels: ProviderModelMetadata[] = [],
): SessionControlState {
  const metadata = resolveRegisteredRuntimeModelMetadata(
    input.model ?? DEFAULT_MODEL_REF,
    extraModels,
  );
  const candidateReasoning = input.reasoning_effort;
  const reasoning =
    candidateReasoning &&
    metadata.reasoning_efforts.includes(candidateReasoning)
      ? candidateReasoning
      : metadata.default_reasoning_effort;
  return {
    model: metadata.model_ref,
    reasoning_effort: reasoning,
    access_mode:
      input.access_mode === "ask_first" || input.access_mode === "read_only"
        ? input.access_mode
        : "full_access",
    plan_mode: Boolean(input.plan_mode),
  };
}

export function positiveTokenCount(input: unknown): number | undefined {
  if (typeof input !== "number" || !Number.isFinite(input)) return undefined;
  const value = Math.trunc(input);
  return value > 0 ? value : undefined;
}
