/// <reference types="bun" />

import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { toast } from "sonner";
import { EMPTY_MODEL_CATALOG, EMPTY_SETTINGS } from "@/app/constants.ts";
import { getAppLocale, setAppCopyLanguage } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ModelCatalogView, SettingsView } from "@/app/types.ts";
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
    expect(title).toBe("설정 업데이트 실패");
    expect(options.description).toBe(
      "선택한 모델을 더 이상 사용할 수 없습니다. 설정 > 모델에서 다른 모델을 선택해 주세요.",
    );
    expect(options.description).not.toContain("not an available model");
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
    const [, options] = toastError.mock.calls[0] as [string, { description?: string }];
    expect(options.description).toBe(
      "The selected model is no longer available. Choose another model in Settings > Models.",
    );
    expect(requests).toEqual(["PATCH /settings", "GET /model-catalog"]);
  } finally {
    toastError.mockRestore();
    globalThis.fetch = originalFetch;
  }
});
