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
      }),
    ).toMatchObject({ state: "loading", model: "" });
  });

  test("uses exact session controls only when catalog generations agree", () => {
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
      }),
    ).toMatchObject({
      state: "loading",
      model: "",
      generationMismatch: true,
    });
  });

  test("preserves an unavailable selected ref instead of substituting another model", () => {
    const result = resolveComposerModelTruth({
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
      settings: EMPTY_SETTINGS,
    });
    expect(result).toMatchObject({
      state: "unavailable",
      model: "openai/removed-model",
    });
    expect(result.metadata).toBeUndefined();
  });

});
