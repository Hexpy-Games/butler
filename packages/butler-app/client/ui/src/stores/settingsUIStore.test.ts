// test-category: race
/// <reference types="bun" />

import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { toast } from "sonner";
import { EMPTY_MODEL_CATALOG, EMPTY_SETTINGS } from "@/app/constants.ts";
import { getAppLocale, setAppCopyLanguage } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ModelCatalogView, PersonalizationView, SettingsView } from "@/app/types.ts";
import { useSettingsUIStore } from "./settingsUIStore.ts";

const initialAppLocale = getAppLocale();
const initialButlerState = useButlerStore.getState();
const initialSettingsUIState = useSettingsUIStore.getState();
afterAll(() => {
  setAppCopyLanguage(initialAppLocale);
  useButlerStore.setState(initialButlerState, true);
  useSettingsUIStore.setState(initialSettingsUIState, true);
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

function installBridge(bridge: Record<string, unknown>): void {
  (globalThis as { window?: unknown }).window = {
    butlerApp: bridge,
    location: { origin: "http://127.0.0.1:5173" },
  };
}

test("an unavailable model is reported in the interface language and the catalog is refreshed", async () => {
  setAppCopyLanguage("ko");
  const refreshedCatalog = {
    ...EMPTY_MODEL_CATALOG,
    providers: [],
  } as ModelCatalogView;
  const calls: string[] = [];
  installBridge({
    // Same envelope the Electron preload returns for a gateway 400.
    updateSettings: async () => {
      calls.push("updateSettings");
      return {
        ok: false,
        error: {
          schema: "butler.app.bridge-error.v1",
          code: "settings_model_unavailable",
          status: 400,
        },
      };
    },
    getModelCatalog: async () => {
      calls.push("getModelCatalog");
      return refreshedCatalog;
    },
  });
  const previous: SettingsView = { ...EMPTY_SETTINGS, model: "local/stub" };
  useSettingsUIStore.setState({ draft: previous, saving: false });
  const applied: SettingsView[] = [];
  const toastError = spyOn(toast, "error");
  try {
    await useSettingsUIStore
      .getState()
      .update({ model: "local/missing" }, (next) => applied.push(next));

    expect(toastError).toHaveBeenCalledTimes(1);
    const [title, options] = toastError.mock.calls[0] as [
      string,
      { description?: string },
    ];
    expect(title).toBe("선택한 모델을 더 이상 사용할 수 없습니다.");
    expect(options.description).toBeUndefined();
    // The draft keeps the previous model; nothing was applied.
    expect(useSettingsUIStore.getState().draft?.model).toBe("local/stub");
    expect(applied).toHaveLength(0);
    expect(useSettingsUIStore.getState().saving).toBe(false);
    expect(calls).toEqual(["updateSettings", "getModelCatalog"]);
    expect(useButlerStore.getState().modelCatalog).toBe(refreshedCatalog);
  } finally {
    toastError.mockRestore();
  }
});

test("a browser 400 settings_model_unavailable maps to the same localized copy", async () => {
  setAppCopyLanguage("en");
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/settings") {
      return new Response(
        JSON.stringify({
          protocol_version: "butler.app.v1",
          error: {
            code: "settings_model_unavailable",
            message: "The selected model is not an available model.",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ protocol_version: "butler.app.v1", data: EMPTY_MODEL_CATALOG }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  useSettingsUIStore.setState({
    draft: { ...EMPTY_SETTINGS, model: "local/stub" },
    saving: false,
  });
  const toastError = spyOn(toast, "error");
  try {
    await useSettingsUIStore.getState().update({ model: "local/missing" }, () => {});
    const [title, options] = toastError.mock.calls[0] as [string, { description?: string }];
    expect(title).toBe("That model is no longer available.");
    expect(options.description).toBeUndefined();
    expect(requests).toEqual(["PATCH /settings", "GET /model-catalog"]);
  } finally {
    toastError.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

const personalization = (persona: string) =>
  ({
    persona,
    eol: "",
    updated_at: "2026-09-28T00:00:00.000Z",
    persona_presets: [],
    profile: {
      butler_nickname: "",
      principal_name: "",
      preferred_address: "",
      updated_at: null,
      storage_label: "",
    },
    profiling: {
      mode: "off",
      enabled: false,
      consent_version: "",
      consented_at: null,
      storage_label: "",
      raw_profile_browser_visible: false,
      extractor_model: "default",
    },
  }) as unknown as PersonalizationView;

test("a live settings change moves the baseline and keeps unsaved draft fields", async () => {
  let persona = "Saved persona";
  installBridge({ getPersonalization: async () => personalization(persona) });
  const store = useSettingsUIStore.getState();
  useSettingsUIStore.setState({ draft: null, baseline: null });
  const opened: SettingsView = { ...EMPTY_SETTINGS, server_url: "http://127.0.0.1:18765" };
  await store.initialize(opened, "appearance");
  // Unsaved edits: a typed server URL and a persona.
  store.setDraft({ ...useSettingsUIStore.getState().draft!, server_url: "http://127.0.0.1:1" });
  store.setPersonalizationDraft((draft) => ({ ...draft, persona: "Unsaved persona" }));

  const wallpaper = {
    source: { kind: "live", module: "butler.silk" },
    motion: "paused",
    pauseOnBattery: true,
  } as const;
  persona = "Saved persona";
  const remote: SettingsView = { ...opened, wallpaper, appearance_theme: "dark" };
  await store.initialize(remote, "appearance");

  const state = useSettingsUIStore.getState();
  expect(state.baseline?.wallpaper).toEqual(wallpaper);
  expect(state.draft?.wallpaper).toEqual(wallpaper);
  expect(state.draft?.appearance_theme).toBe("dark");
  expect(state.draft?.server_url).toBe("http://127.0.0.1:1");
  expect(state.baseline?.server_url).toBe("http://127.0.0.1:18765");
  expect(state.personalizationDraft.persona).toBe("Unsaved persona");
});

test("a saved PATCH updates the baseline and the saved field but keeps other unsaved fields", async () => {
  const patches: unknown[] = [];
  const wallpaper = {
    source: { kind: "none" },
    motion: "auto",
    pauseOnBattery: false,
  } as const;
  installBridge({
    updateSettings: async (patch: unknown) => {
      patches.push(patch);
      return { ...EMPTY_SETTINGS, wallpaper };
    },
  });
  useSettingsUIStore.setState({
    draft: { ...EMPTY_SETTINGS, server_url: "http://127.0.0.1:1" },
    baseline: { ...EMPTY_SETTINGS },
    saving: false,
  });
  const applied: SettingsView[] = [];
  await useSettingsUIStore
    .getState()
    .update({ wallpaper: { source: { kind: "none" } } }, (next) => applied.push(next));

  expect(patches).toEqual([{ wallpaper: { source: { kind: "none" } } }]);
  const state = useSettingsUIStore.getState();
  expect(state.draft?.wallpaper).toEqual(wallpaper);
  expect(state.baseline?.wallpaper).toEqual(wallpaper);
  expect(state.draft?.server_url).toBe("http://127.0.0.1:1");
  // The app store gets what the gateway saved, not the unsaved draft.
  expect(applied[0]?.server_url).toBe(EMPTY_SETTINGS.server_url);
  expect(applied[0]?.wallpaper).toEqual(wallpaper);
});
