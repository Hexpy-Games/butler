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

export function resolveComposerModelTruth(input: {
  catalog: ModelCatalogView;
  catalogState: ModelCatalogState;
  controls: SessionControlsView | null;
  controlsState: ControlsLoadState;
  settings: SettingsView;
}): ComposerModelResolution {
  const preferredModel =
    input.controls?.controls.model ||
    input.settings.model ||
    input.catalog.default_model_ref;
  const base = {
    model: preferredModel,
    reasoning:
      input.controls?.controls.reasoning_effort ||
      input.settings.reasoning_effort,
    accessMode:
      input.controls?.controls.access_mode || input.settings.access_mode,
    planMode: Boolean(
      input.controls?.controls.plan_mode ?? input.settings.plan_mode_default,
    ),
    generationMismatch: false,
  };
  if (input.catalogState === "loading" || input.controlsState === "loading") {
    return { ...base, state: "loading", model: "" };
  }
  if (input.catalogState === "error" || input.controlsState === "error") {
    return { ...base, state: "error" };
  }
  const models = runtimeModels(input.catalog);
  if (input.catalogState === "unavailable" || models.length === 0) {
    return { ...base, state: "unavailable" };
  }
  if (
    input.controls &&
    input.controls.catalog_generation !== input.catalog.generation
  ) {
    return {
      ...base,
      state: "loading",
      model: "",
      generationMismatch: true,
    };
  }
  const metadata = models.find((model) => model.model_ref === preferredModel);
  if (!metadata) return { ...base, state: "unavailable" };
  const reasoning = metadata.reasoning_efforts.includes(base.reasoning)
    ? base.reasoning
    : metadata.default_reasoning_effort;
  return { ...base, state: "ready", metadata, reasoning };
}
