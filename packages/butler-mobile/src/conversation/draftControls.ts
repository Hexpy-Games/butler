import type { ModelCatalog, ReasoningEffort } from "../../../butler-protocol/src/index.ts";
import type { SettingsView } from "../settings/types";

export type DraftControls = { model: string; reasoning_effort: ReasoningEffort };

/** A new chat's controls before its session exists; mirrors D/components/conversation/composerModelResolution.ts:52-71. */
export function draftControls(catalog: ModelCatalog, settings: Pick<SettingsView, "model" | "reasoning_effort">): DraftControls | null {
  const models = (catalog.registered_models?.length ? catalog.registered_models : catalog.models)
    .filter(model => !model.availability || model.availability === "ready");
  const model = [settings.model, catalog.default_model_ref]
    .map(ref => models.find(item => item.model_ref === ref))
    .find(item => item !== undefined) ?? models[0];
  if (!model) return null;
  return { model: model.model_ref, reasoning_effort: model.reasoning_efforts.includes(settings.reasoning_effort) ? settings.reasoning_effort : model.default_reasoning_effort };
}
