import {
  DEFAULT_MODEL_REF,
  defaultWorkerModelRules,
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
  WorkerModelRule,
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
  const primary = allKnownModels(registeredModels).find(
    (model) => model.model_ref === primaryModelRef,
  );
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
    const model = selectableByRef.get(requested.trim());
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
  return {
    ...input,
    model: input.model === previousModelRef ? nextModelRef : input.model,
    consolidation_model:
      input.consolidation_model === previousModelRef
        ? nextModelRef
        : input.consolidation_model,
    worker_model_rules: Array.isArray(input.worker_model_rules)
      ? input.worker_model_rules.map((rule) => ({
          ...rule,
          model: rule.model === previousModelRef ? nextModelRef : rule.model,
        }))
      : input.worker_model_rules,
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
  const match = models
    .filter((model) => model.runtime_supported)
    .find((model) => model.model_ref === value || model.model_id === value);
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

export function normalizeWorkerModelRules(
  input: unknown,
  extraModels: ProviderModelMetadata[] = [],
  initialModelRef?: string,
): WorkerModelRule[] {
  const fallbackRules = defaultWorkerModelRulesFor(extraModels, initialModelRef);
  const rawRules = Array.isArray(input) ? input : fallbackRules;
  const normalized = rawRules.slice(0, 12).flatMap((rule, index) => {
    if (!rule || typeof rule !== "object") return [];
    const candidate = rule as Partial<WorkerModelRule>;
    const model =
      typeof candidate.model === "string"
        ? normalizeKnownModelRef(candidate.model, extraModels)
        : undefined;
    if (!model) return [];
    const metadata = resolveRegisteredRuntimeModelMetadata(model, extraModels);
    const requestedReasoning = candidate.reasoning_effort;
    const reasoning =
      requestedReasoning &&
      metadata.reasoning_efforts.includes(requestedReasoning)
        ? requestedReasoning
        : metadata.default_reasoning_effort;
    return [
      {
        id: safeWorkerRuleId(candidate.id, index),
        label: safeWorkerRuleText(
          candidate.label,
          index === 0 ? "Deep work" : "Routine work",
          48,
        ),
        condition: safeWorkerRuleText(
          candidate.condition,
          "Worker model condition",
          160,
        ),
        model: metadata.model_ref,
        reasoning_effort: reasoning,
        enabled: candidate.enabled !== false,
      },
    ];
  });
  return normalized.length > 0 ? normalized : fallbackRules;
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

function defaultWorkerModelRulesFor(
  extraModels: ProviderModelMetadata[] = [],
  initialModelRef?: string,
): WorkerModelRule[] {
  if (initialModelRef) {
    const model = resolveRegisteredRuntimeModelMetadata(
      initialModelRef,
      extraModels,
    );
    return workerRulesForModel(model);
  }
  if (extraModels.length === 0) return defaultWorkerModelRules();
  const selectable = extraModels.filter((model) => model.runtime_supported);
  if (selectable.length === 0) return [];
  return workerRulesForModel(selectable[0]!);
}

function workerRulesForModel(model: ProviderModelMetadata): WorkerModelRule[] {
  return [
    {
      id: "deep_work",
      label: "Deep work",
      condition:
        "Research, feature-level development, architecture, review, and analysis",
      model: model.model_ref,
      reasoning_effort: model.reasoning_efforts.includes("high")
        ? "high"
        : model.default_reasoning_effort,
      enabled: true,
    },
    {
      id: "routine_work",
      label: "Routine work",
      condition:
        "Simple coding, search, local inspection, formatting, and tool calls",
      model: model.model_ref,
      reasoning_effort: model.reasoning_efforts.includes("medium")
        ? "medium"
        : model.default_reasoning_effort,
      enabled: true,
    },
  ];
}

function safeWorkerRuleId(input: unknown, index: number): string {
  const value =
    typeof input === "string" ? input.trim().toLocaleLowerCase("en-US") : "";
  const normalized = value
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized || `worker_rule_${index + 1}`;
}

function safeWorkerRuleText(
  input: unknown,
  fallback: string,
  maxLength: number,
): string {
  const value =
    typeof input === "string" ? input.replace(/\s+/gu, " ").trim() : "";
  if (!value) return fallback;
  return value.length > maxLength
    ? value.slice(0, maxLength - 1).trimEnd()
    : value;
}
