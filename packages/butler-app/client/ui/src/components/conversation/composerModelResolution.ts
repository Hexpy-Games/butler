import { runtimeModels } from "../../app/utils.ts";
import type {
  AccessMode,
  AppModelSummary,
  ComposerModelState,
  ModelCatalogState,
  ModelCatalogView,
  ReasoningEffort,
  SessionControlsView,
  SettingsView,
  ControlsLoadState,
} from "../../app/types.ts";

export interface ComposerModelResolution {
  state: ComposerModelState;
  model: string;
  metadata?: AppModelSummary;
  reasoning: ReasoningEffort;
  accessMode: AccessMode;
  planMode: boolean;
  generationMismatch: boolean;
}

/**
 * The model the composer shows. A model that no longer exists falls back to
 * the Settings default, then to the first available model; a failed controls
 * read uses the Settings controls. Only a catalog with no model at all leaves
 * the composer without one.
 */
export function resolveComposerModelTruth(input: {
  catalog: ModelCatalogView;
  catalogState: ModelCatalogState;
  controls: SessionControlsView | null;
  controlsState: ControlsLoadState;
  settings: SettingsView;
  planModeAvailable: boolean;
}): ComposerModelResolution {
  const controls = input.controlsState === "ready" ? input.controls : null;
  const base = {
    reasoning:
      controls?.controls.reasoning_effort ||
      input.settings.reasoning_effort,
    accessMode:
      controls?.controls.access_mode || input.settings.access_mode,
    planMode: input.planModeAvailable && Boolean(
      controls?.controls.plan_mode ?? input.settings.plan_mode_default,
    ),
    generationMismatch: Boolean(
      controls && controls.catalog_generation !== input.catalog.generation,
    ),
  };
  const selected = controls?.controls.model || input.settings.model;
  const unavailable = input.catalog.registered_models?.find(model => model.model_ref === selected
    && model.availability !== undefined && model.availability !== "ready");
  if (unavailable) return { ...base, state: "unavailable", model: selected, metadata: unavailable };
  const models = runtimeModels(input.catalog);
  if (models.length === 0) {
    const settled = input.catalogState === "ready" || input.catalogState === "unavailable";
    return { ...base, state: settled ? "unavailable" : "loading", model: "" };
  }
  if (input.controlsState === "loading") {
    return { ...base, state: "loading", model: "" };
  }
  const metadata =
    [controls?.controls.model, input.settings.model, input.catalog.default_model_ref]
      .map((ref) => models.find((model) => model.model_ref === ref))
      .find((model) => model !== undefined) ?? models[0]!;
  const reasoning = metadata.reasoning_efforts.includes(base.reasoning)
    ? base.reasoning
    : metadata.default_reasoning_effort;
  return { ...base, state: "ready", model: metadata.model_ref, metadata, reasoning };
}
