import type { AppModelSummary, SettingsView } from "@/app/types.ts";

export const MAX_BACKUP_MODELS = 5;

export function modelIdentityKey(
  model: Pick<AppModelSummary, "provider_id" | "provider_family_id" | "model_id">,
): string {
  return `${model.provider_family_id?.trim() || model.provider_id}:${model.model_id}`;
}

export function selectableBackupModels(
  models: AppModelSummary[],
  primaryRef: string,
  selectedRefs: string[],
): AppModelSummary[] {
  const selected = new Set(selectedRefs);
  const primary = models.find((model) => model.model_ref === primaryRef);
  const primaryIdentity = primary ? modelIdentityKey(primary) : null;
  const selectedIdentities = new Set(
    models
      .filter((model) => selected.has(model.model_ref))
      .map(modelIdentityKey),
  );
  return models.filter((model) => {
    if (
      model.registered !== true ||
      model.enabled === false ||
      !model.runtime_supported ||
      model.model_ref === primaryRef
    ) {
      return false;
    }
    if (selected.has(model.model_ref)) return false;
    const identity = modelIdentityKey(model);
    return identity !== primaryIdentity && !selectedIdentities.has(identity);
  });
}

export function addBackupModel(
  fallback: SettingsView["model_fallback"],
  modelRef: string,
): SettingsView["model_fallback"] {
  if (
    fallback.models.length >= MAX_BACKUP_MODELS ||
    fallback.models.includes(modelRef)
  ) {
    return fallback;
  }
  return {
    enabled: fallback.enabled,
    models: [...fallback.models, modelRef],
  };
}
