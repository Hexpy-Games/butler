import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EMPTY_MODEL_CATALOG, EMPTY_SETTINGS } from "../../packages/butler-app/client/ui/src/app/constants.ts";
import { useButlerStore } from "../../packages/butler-app/client/ui/src/app/store.ts";
import { useSettingsUIStore } from "../../packages/butler-app/client/ui/src/stores/settingsUIStore.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  useButlerStore.setState({
    settings: EMPTY_SETTINGS,
    modelCatalog: EMPTY_MODEL_CATALOG,
  });
  useSettingsUIStore.setState({
    draft: null,
    saving: false,
  });
});

test("settings store sends and applies the canonical model fallback patch", async () => {
  const draft = {
    ...EMPTY_SETTINGS,
    model_fallback: { enabled: false, models: [] },
  };
  useSettingsUIStore.setState({ draft });
  const requests: RequestInit[] = [];
  globalThis.fetch = (async (_input, init) => {
    requests.push(init ?? {});
    return new Response(
      JSON.stringify({
        data: {
          ...draft,
          model_fallback: {
            enabled: true,
            models: ["zai-api/glm-5.1"],
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  await useSettingsUIStore.getState().update(
    {
      model_fallback: {
        enabled: true,
        models: ["zai-api/glm-5.1"],
      },
    },
    useButlerStore.getState().setSettings,
  );

  expect(JSON.parse(String(requests[0]?.body))).toEqual({
    model_fallback: {
      enabled: true,
      models: ["zai-api/glm-5.1"],
    },
  });
  expect(useSettingsUIStore.getState().draft?.model_fallback).toEqual({
    enabled: true,
    models: ["zai-api/glm-5.1"],
  });
  expect(useButlerStore.getState().settings.model_fallback).toEqual({
    enabled: true,
    models: ["zai-api/glm-5.1"],
  });
});

test("backup model feature stays within the Butler DS boundary", () => {
  const featureFiles = [
    "BackupModelsSettings.tsx",
    "BackupModelPicker.tsx",
    "BackupModelCards.tsx",
    "BackupModelsDescription.tsx",
    "backupModelsUtils.ts",
  ];
  for (const fileName of featureFiles) {
    const source = readFileSync(
      new URL(
        `../../packages/butler-app/client/ui/src/components/settings/${fileName}`,
        import.meta.url,
      ),
      "utf8",
    );
    if (fileName !== "backupModelsUtils.ts") {
      expect(source).toContain('from "@/butler-ds"');
    }
    expect(source).not.toContain(".module.css");
    expect(source).not.toContain("@radix-ui");
    expect(source).not.toContain("@dnd-kit");
    expect(source).not.toMatch(/\bstyle\s*=/u);
  }
});
