// test-category: pure-logic
import { expect, test } from "bun:test";
import type { ModelCatalog } from "../../../butler-protocol/src/index.ts";
import { draftControls } from "./draftControls";

test("draft controls follow Settings, then the catalog default, then the first ready model", () => {
  const catalog: ModelCatalog = {
    generation: "1", default_model_ref: "b", default_reasoning_effort: "low",
    models: [
      { provider_id: "provider", provider_label: "Provider", model_id: "a", model_ref: "a", display_name: "A",
        availability: "sign_in_required", reasoning_efforts: ["low", "medium"], default_reasoning_effort: "low" },
      { provider_id: "provider", provider_label: "Provider", model_id: "b", model_ref: "b", display_name: "B",
        availability: "ready", reasoning_efforts: ["low", "medium"], default_reasoning_effort: "low" },
      { provider_id: "provider", provider_label: "Provider", model_id: "c", model_ref: "c", display_name: "C",
        availability: "ready", reasoning_efforts: ["low", "medium"], default_reasoning_effort: "low" },
    ],
  };
  expect(draftControls(catalog, { model: "c", reasoning_effort: "medium" })).toEqual({ model: "c", reasoning_effort: "medium" });
  expect(draftControls(catalog, { model: "missing", reasoning_effort: "medium" })?.model).toBe("b");
  expect(draftControls({ ...catalog, default_model_ref: "a" }, { model: "missing", reasoning_effort: "medium" })?.model).toBe("b");
  expect(draftControls(catalog, { model: "c", reasoning_effort: "high" })).toEqual({ model: "c", reasoning_effort: "low" });
});
