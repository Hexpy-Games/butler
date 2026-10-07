// test-category: pure-logic
import type { AppModelSummary } from "@/app/types.ts";
import { expect, test } from "bun:test";
import { selectableBackupModels } from "./backupModelsUtils";

function model(
  modelRef: string,
  displayName: string,
  registered = true,
): AppModelSummary {
  const [providerId, modelId] = modelRef.split("/");
  return {
    provider_id: providerId ?? "openai",
    provider_label: providerId === "zai-api" ? "Z.AI API" : "OpenAI",
    provider_family_id: providerId === "zai-api" ? "zai" : providerId,
    model_id: modelId ?? modelRef,
    model_ref: modelRef,
    display_name: displayName,
    status: "available",
    default_reasoning_effort: "medium",
    reasoning_efforts: ["medium"],
    token_estimator: "character_estimate",
    runtime_supported: true,
    registered,
  };
}

const primary = model("openai/primary", "Primary model");

test("candidate filtering removes provider-family aliases for the same model", () => {
  const zai = model("zai/glm-5.2", "GLM-5.2");
  const zaiApiAlias = {
    ...model("zai-api/glm-5.2", "GLM-5.2 API alias"),
    provider_family_id: "zai",
  };
  expect(
    selectableBackupModels(
      [primary, zai, zaiApiAlias],
      primary.model_ref,
      [zai.model_ref],
    ),
  ).toEqual([]);
});
