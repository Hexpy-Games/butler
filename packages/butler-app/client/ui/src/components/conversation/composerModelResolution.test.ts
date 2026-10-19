// test-category: race
import { describe, expect, test } from "bun:test";
import { EMPTY_MODEL_CATALOG, EMPTY_SETTINGS } from "@/app/constants.ts";
import { HARNESS_MODEL_CATALOG } from "@/app/fixtures.ts";
import { runtimeModels } from "@/app/utils.ts";
import { resolveComposerModelTruth } from "./composerModelResolution.ts";

describe("composer model truth", () => {
  test("empty bootstrap state never fabricates a real model", () => {
    expect(runtimeModels(EMPTY_MODEL_CATALOG)).toEqual([]);
    expect(
      resolveComposerModelTruth({
        catalog: EMPTY_MODEL_CATALOG,
        catalogState: "loading",
        controls: null,
        controlsState: "loading",
        settings: EMPTY_SETTINGS,
        planModeAvailable: false,
      }),
    ).toMatchObject({ state: "loading", model: "" });
  });

  test("uses session controls and flags a catalog generation to refresh", () => {
    const controls = {
      session_id: "general",
      revision: 3,
      catalog_generation: HARNESS_MODEL_CATALOG.generation,
      controls: {
        model: "openai/gpt-5.6-sol",
        reasoning_effort: "medium" as const,
        access_mode: "full_access" as const,
        plan_mode: false,
      },
    };
    expect(
      resolveComposerModelTruth({
        catalog: HARNESS_MODEL_CATALOG,
        catalogState: "ready",
        controls,
        controlsState: "ready",
        settings: EMPTY_SETTINGS,
        planModeAvailable: false,
      }),
    ).toMatchObject({
      state: "ready",
      model: "openai/gpt-5.6-sol",
      reasoning: "medium",
      generationMismatch: false,
    });
    expect(
      resolveComposerModelTruth({
        catalog: HARNESS_MODEL_CATALOG,
        catalogState: "ready",
        controls: { ...controls, catalog_generation: "new-generation" },
        controlsState: "ready",
        settings: EMPTY_SETTINGS,
        planModeAvailable: false,
      }),
    ).toMatchObject({
      state: "ready",
      model: "openai/gpt-5.6-sol",
      generationMismatch: true,
    });
  });

  test("a deleted selected model falls back to the Settings default, then the first model", () => {
    const input = {
      catalog: HARNESS_MODEL_CATALOG,
      catalogState: "ready",
      controls: {
        session_id: "general",
        revision: 4,
        catalog_generation: HARNESS_MODEL_CATALOG.generation,
        controls: {
          model: "openai/removed-model",
          reasoning_effort: "medium",
          access_mode: "full_access",
          plan_mode: false,
        },
      },
      controlsState: "ready",
      planModeAvailable: false,
    } as const;
    const models = runtimeModels(HARNESS_MODEL_CATALOG);
    const fallback = models.at(-1)!.model_ref;
    expect(
      resolveComposerModelTruth({ ...input, settings: { ...EMPTY_SETTINGS, model: fallback } }),
    ).toMatchObject({ state: "ready", model: fallback });
    expect(
      resolveComposerModelTruth({
        ...input,
        catalog: { ...HARNESS_MODEL_CATALOG, default_model_ref: "openai/also-removed" },
        settings: { ...EMPTY_SETTINGS, model: "openai/also-removed" },
      }),
    ).toMatchObject({ state: "ready", model: models[0]!.model_ref });
  });

  test("a failed controls read keeps the picker on the Settings model", () => {
    const result = resolveComposerModelTruth({
      catalog: HARNESS_MODEL_CATALOG,
      catalogState: "ready",
      controls: null,
      controlsState: "error",
      settings: { ...EMPTY_SETTINGS, model: HARNESS_MODEL_CATALOG.default_model_ref },
      planModeAvailable: false,
    });
    expect(result).toMatchObject({ state: "ready", model: HARNESS_MODEL_CATALOG.default_model_ref });
  });

  test("only an empty catalog leaves the composer without a model", () => {
    const input = { controls: null, controlsState: "ready", settings: EMPTY_SETTINGS, planModeAvailable: false } as const;
    expect(
      resolveComposerModelTruth({ ...input, catalog: EMPTY_MODEL_CATALOG, catalogState: "unavailable" }).state,
    ).toBe("unavailable");
    expect(
      resolveComposerModelTruth({ ...input, catalog: EMPTY_MODEL_CATALOG, catalogState: "error" }).state,
    ).toBe("loading");
  });

  test("new chats default to ask_except_reads and keep a chosen access mode", () => {
    const input = {
      catalog: HARNESS_MODEL_CATALOG,
      catalogState: "ready",
      controls: null,
      controlsState: "ready",
      planModeAvailable: false,
    } as const;
    expect(resolveComposerModelTruth({ ...input, settings: EMPTY_SETTINGS }).accessMode).toBe("ask_except_reads");
    expect(
      resolveComposerModelTruth({ ...input, settings: { ...EMPTY_SETTINGS, access_mode: "full_access" } }).accessMode,
    ).toBe("full_access");
  });

  test("never enables Plan mode without a project session", () => {
    const result = resolveComposerModelTruth({
      catalog: HARNESS_MODEL_CATALOG,
      catalogState: "ready",
      controls: null,
      controlsState: "ready",
      settings: { ...EMPTY_SETTINGS, plan_mode_default: true },
      planModeAvailable: false,
    });
    expect(result.planMode).toBe(false);
  });

});
