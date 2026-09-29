/// <reference types="bun" />
import { afterAll, expect, spyOn, test } from "bun:test";
import { JSDOM } from "jsdom";
import { toast } from "sonner";
import { EMPTY_SETTINGS } from "@/app/constants.ts";
import { getAppLocale, setAppCopyLanguage } from "@/app/copy.ts";
import type { SettingsView } from "@/app/types.ts";
import type { WallpaperAsset } from "@/app/wallpaperAssets.ts";
import { SettingsFieldScopeProvider, type WallpaperSetting } from "@/butler-ds";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { MainScreenThemeSettings } from "./MainScreenThemeSettings";

const initialLocale = getAppLocale();
const initialSettingsUIState = useSettingsUIStore.getState();
afterAll(() => {
  setAppCopyLanguage(initialLocale);
  useSettingsUIStore.setState(initialSettingsUIState, true);
});

const ASSET: WallpaperAsset = { id: "wp_bright", width: 1600, height: 900, luminance: 0.8, color: "#dddddd", bytes: 1000, createdAt: "2026-09-28T00:00:00Z" };
const OLD: WallpaperAsset = { ...ASSET, id: "wp_old", luminance: 0.3 };
/** Past the save debounce. */
const settleSave = () => new Promise((resolve) => setTimeout(resolve, 400));

type Interact = (view: { document: Document; window: JSDOM["window"] }) => void | Promise<void>;

/**
 * Renders the Home screen controls over `wallpaper` with a desktop bridge
 * double (settings PATCH and the wallpaper routes), runs `interact` and
 * returns the settings PATCH bodies, the wallpaper bridge calls and the
 * settled markup.
 */
async function render(
  wallpaper: WallpaperSetting,
  interact: Interact,
  { deleteCode, importResult }: { deleteCode?: string; importResult?: { ok: false; error: { code: string; message?: string } } } = {},
) {
  setAppCopyLanguage("en");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const patches: unknown[] = [];
  const calls: string[] = [];
  const settings: SettingsView = { ...EMPTY_SETTINGS, wallpaper };
  Object.assign(dom.window, {
    butlerApp: {
      updateSettings: async (patch: { wallpaper?: Partial<WallpaperSetting> }) => {
        patches.push(patch);
        return { ...settings, wallpaper: { ...settings.wallpaper, ...patch.wallpaper } };
      },
      listWallpapers: async () => ({ ok: true, data: { wallpapers: [OLD] } }),
      uploadWallpaper: async ({ name }: { name: string }) => {
        calls.push(`upload ${name}`);
        return { ok: true, data: ASSET };
      },
      deleteWallpaper: async ({ id }: { id: string }) => {
        calls.push(`delete ${id}`);
        return deleteCode ? { ok: false, error: { code: deleteCode, status: 409 } } : { ok: true, data: { id, deleted: true } };
      },
      readWallpaperImage: async () => ({ ok: false, error: { code: "wallpaper_not_found", status: 404 } }),
      // The desktop bridge has no import/delete for modules yet: the client falls back to same-origin fetch.
      listWallpaperModules: async () => ({ ok: true, data: { modules: [] } }),
    },
  });
  const keys = ["window", "document", "navigator", "HTMLElement", "Node", "DocumentFragment", "MutationObserver", "IS_REACT_ACT_ENVIRONMENT"];
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, DocumentFragment: dom.window.DocumentFragment,
    MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  });
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`fetch ${init?.method ?? "GET"} ${String(input)}`);
    if (String(input) === "/wallpaper-modules/import") {
      if (importResult) return new Response(JSON.stringify(importResult), { status: 400 });
      const data = { id: "me.flow", name: { en: "Flow", ko: "흐름" }, version: "0.1.0", engine: 1, motion: "static", image: "none", params: [], source: "user", status: { state: "unknown" } };
      return new Response(JSON.stringify({ protocol_version: "butler.app.v1", data }), { status: 201 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  useSettingsUIStore.setState({ draft: settings, baseline: settings, saving: false });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(<SettingsFieldScopeProvider><MainScreenThemeSettings /></SettingsFieldScopeProvider>));
    await act(async () => interact({ document: dom.window.document, window: dom.window }));
    // Settled markup, read after unmount.
    return { patches, calls, document: new JSDOM(dom.window.document.body.innerHTML).window.document };
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = savedFetch;
    saved.forEach(([key, descriptor]) => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    });
  }
}

const field = (document: Document, id: string) => document.querySelector(`[data-setting-id="${id}"]`);
const toggle = (document: Document, id: string) =>
  (field(document, id)?.querySelector('[role="switch"]') as HTMLElement).click();
const tile = (document: Document, key: string) => document.querySelector<HTMLButtonElement>(`[data-option="${key}"] [role="radio"]`);

test("motion and battery switches PATCH the wallpaper setting", async () => {
  const wallpaper: WallpaperSetting = { source: { kind: "live", module: "butler.silk" }, motion: "auto", pauseOnBattery: false };
  const { patches } = await render(wallpaper, ({ document }) => {
    toggle(document, "main-screen-battery");
    toggle(document, "main-screen-motion");
  });
  expect(patches).toEqual([
    { wallpaper: { pauseOnBattery: true } },
    { wallpaper: { motion: "paused" } },
  ]);
});

test("the picker shows the stored source and lists the gateway's images", async () => {
  const wallpaper: WallpaperSetting = { source: { kind: "live", module: "butler.bloom", params: { colors: "aurora" } }, motion: "paused", pauseOnBattery: false };
  const { document } = await render(wallpaper, () => undefined);
  expect(tile(document, "live:butler.bloom")?.getAttribute("aria-checked")).toBe("true");
  expect(tile(document, "image:wp_old")?.textContent).toBe("Image 1");
  expect(field(document, "main-screen-wallpaper")?.querySelector('[aria-checked="true"]')?.textContent).toBe("Bloom");
  // Bloom's palette control shows the stored preset.
  expect([...document.querySelectorAll('[role="radiogroup"][aria-label="Colors"] [aria-checked="true"]')].map((radio) => radio.textContent)).toEqual(["Aurora"]);
  // Battery only matters while the wallpaper moves.
  expect(field(document, "main-screen-battery")).toBeNull();
});

test("a tile choice updates the draft at once and PATCHes the source once edits pause", async () => {
  const wallpaper: WallpaperSetting = { source: { kind: "live", module: "butler.bloom" }, motion: "auto", pauseOnBattery: false };
  const { patches } = await render(wallpaper, async ({ document }) => {
    tile(document, "live:butler.silk")?.click();
    expect(useSettingsUIStore.getState().draft?.wallpaper.source).toEqual({ kind: "live", module: "butler.silk" });
    tile(document, "none")?.click();
    await settleSave();
  });
  // Silk was only a step on the way: one PATCH, the last source.
  expect(patches).toEqual([{ wallpaper: { source: { kind: "none" } } }]);
});

test("an upload selects the new image, dimmed for its luminance", async () => {
  const wallpaper: WallpaperSetting = { source: { kind: "live", module: "butler.bloom" }, motion: "auto", pauseOnBattery: false };
  const { patches, calls } = await render(wallpaper, async ({ document, window }) => {
    const input = document.querySelector<HTMLInputElement>('[data-option="upload"] input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new window.File(["png"], "sea.png", { type: "image/png" })] });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settleSave();
  });
  expect(calls).toEqual(["upload sea.png"]);
  expect(patches).toEqual([{ wallpaper: { source: { kind: "image", asset: "wp_bright", fit: "cover", dim: 0.35, blur: 0 } } }]);
});

test("importing a module selects it", async () => {
  const wallpaper: WallpaperSetting = { source: { kind: "live", module: "butler.bloom" }, motion: "auto", pauseOnBattery: false };
  const { patches, calls } = await render(wallpaper, async ({ document, window }) => {
    const input = document.querySelector<HTMLInputElement>('[data-option="import-module"] input[type="file"]')!;
    // Bun's global File, not jsdom's: fetch's FormData needs a Blob it recognizes.
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["z"], "flow.zip", { type: "application/zip" })] });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settleSave();
  });
  expect(calls).toEqual(["fetch POST /wallpaper-modules/import"]);
  expect(patches).toEqual([{ wallpaper: { source: { kind: "live", module: "me.flow" } } }]);
});

test("an import error is a brief toast", async () => {
  const toastError = spyOn(toast, "error");
  try {
    const wallpaper: WallpaperSetting = { source: { kind: "none" }, motion: "auto", pauseOnBattery: false };
    const { patches } = await render(wallpaper, async ({ document, window }) => {
      const input = document.querySelector<HTMLInputElement>('[data-option="import-module"] input[type="file"]')!;
      Object.defineProperty(input, "files", { configurable: true, value: [new File(["z"], "bad.zip", { type: "application/zip" })] });
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }, { importResult: { ok: false, error: { code: "wallpaper_module_archive_invalid", message: "shader.frag: missing" } } });
    expect(patches).toEqual([]);
    expect(toastError.mock.calls.map(([message]) => message)).toEqual(["shader.frag: missing"]);
  } finally {
    toastError.mockRestore();
  }
});

test("a wrong file type or an image in use is a brief toast", async () => {
  const toastError = spyOn(toast, "error");
  try {
    const wallpaper: WallpaperSetting = { source: { kind: "none" }, motion: "auto", pauseOnBattery: false };
    const { calls, document } = await render(wallpaper, async ({ document, window }) => {
      const input = document.querySelector<HTMLInputElement>('[data-option="upload"] input[type="file"]')!;
      Object.defineProperty(input, "files", { configurable: true, value: [new window.File(["gif"], "cat.gif", { type: "image/gif" })] });
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      document.querySelector<HTMLButtonElement>('[data-option="image:wp_old"] [aria-label="Delete image"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }, { deleteCode: "wallpaper_in_use" });
    expect(calls).toEqual(["delete wp_old"]);
    expect(toastError.mock.calls.map(([message]) => message)).toEqual(["Use a JPEG, PNG or WebP image.", "Image in use."]);
    expect(document.querySelector('[data-option="image:wp_old"]')).not.toBeNull();
    // No wallpaper: no motion controls.
    expect(field(document, "main-screen-motion")).toBeNull();
  } finally {
    toastError.mockRestore();
  }
});
