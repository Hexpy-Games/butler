/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_SETTINGS } from "@/app/constants.ts";
import type { AppModelSummary, SettingsView } from "@/app/types.ts";
import {
  addBackupModel,
  BackupModelsSettings,
} from "./BackupModelsSettings";
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
const backup = model("zai-api/backup", "Registered backup");
const unregistered = model("zai/other", "Unregistered model", false);

function draftWithFallback(
  modelFallback: SettingsView["model_fallback"],
): SettingsView {
  return {
    ...EMPTY_SETTINGS,
    model: primary.model_ref,
    model_fallback: modelFallback,
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("disabled backup models show only the switch, while enabled models show DS cards", () => {
  const disabledHtml = renderToStaticMarkup(
    <BackupModelsSettings
      models={[primary, backup, unregistered]}
      draft={draftWithFallback({ enabled: false, models: [backup.model_ref] })}
      saving={false}
      onUpdate={async () => undefined}
    />,
  );
  const disabled = new JSDOM(disabledHtml).window.document;
  expect(disabled.querySelector('[data-test-class="settings-backup-model-add"]'))
    .toBeNull();
  expect(disabled.querySelector('[data-test-class="settings-backup-model-list"]'))
    .toBeNull();

  const enabledHtml = renderToStaticMarkup(
    <BackupModelsSettings
      models={[primary, backup, unregistered]}
      draft={draftWithFallback({ enabled: true, models: [backup.model_ref] })}
      saving={false}
      onUpdate={async () => undefined}
    />,
  );
  const enabled = new JSDOM(enabledHtml).window.document;
  expect(enabled.querySelector('[data-test-class="settings-backup-model-add"]'))
    .not.toBeNull();
  expect(enabled.querySelector('[data-test-class="settings-backup-model-list"]'))
    .not.toBeNull();
  expect(enabled.body.textContent ?? "").toContain("Registered backup");
  expect(enabled.body.textContent ?? "").not.toContain("Unregistered model");
});

test("the DS picker add contract appends an ordered registered model", () => {
  const next = addBackupModel(
    { enabled: true, models: [] },
    backup.model_ref,
  );
  expect(next).toEqual({ enabled: true, models: [backup.model_ref] });
  expect(addBackupModel(next, backup.model_ref)).toBe(next);
});

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
