/// <reference types="bun" />
import { afterEach, expect, spyOn, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { getAppLocale, setAppCopyLanguage } from "@/app/copy.ts";
import type { WallpaperModuleListing } from "@/app/wallpaperModules.ts";
import { useWallpaperModules } from "./useWallpaperModules";

const initialLocale = getAppLocale();
const savedFetch = globalThis.fetch;
afterEach(() => {
  setAppCopyLanguage(initialLocale);
  globalThis.fetch = savedFetch;
});

type Bridge = Record<string, (input?: unknown) => Promise<unknown>>;

/** Mounts the hook alone (no picker), over a desktop bridge double when given one, else same-origin fetch; returns handles that flush effects through `act`. */
async function mount(bridge: Bridge | null, routes: Record<string, () => Response> = {}) {
  setAppCopyLanguage("en");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const keys = ["window", "document", "navigator", "HTMLElement", "Node", "MutationObserver", "IS_REACT_ACT_ENVIRONMENT"];
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  });
  if (bridge) Object.assign(dom.window, { butlerApp: bridge });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const route = routes[`${init?.method ?? "GET"} ${String(input)}`];
    return route ? route() : new Response("{}", { status: 404 });
  }) as typeof fetch;
  let latest!: ReturnType<typeof useWallpaperModules>;
  function Harness() {
    latest = useWallpaperModules();
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(<Harness />));
  return {
    api: () => latest,
    act: (run: () => unknown) => act(async () => run()),
    async cleanup() {
      await act(async () => root.unmount());
      saved.forEach(([key, descriptor]) => {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      });
    },
  };
}

const FLOW = { id: "me.flow", name: { en: "Flow", ko: "흐름" }, version: "0.1.0", engine: 1, motion: "static", image: "none", params: [] };
const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ protocol_version: "butler.app.v1", data }), { status });

test("importing installs the module and refreshes the store; no toast", async () => {
  const errorToast = spyOn(toast, "error");
  const calls: string[] = [];
  const view = await mount({
    importWallpaperModule: async (input: unknown) => {
      calls.push(`import ${(input as { name: string }).name}`);
      return { ok: true, data: { ...FLOW, source: "user", status: { state: "unknown" } } };
    },
    listWallpaperModules: async () => {
      calls.push("list");
      return { ok: true, data: { modules: [{ ...FLOW, source: "user", status: { state: "unknown" } }] } };
    },
  });
  try {
    let installed: WallpaperModuleListing | null = null;
    await view.act(async () => {
      installed = await view.api().importModule(new File(["z"], "flow.zip"));
    });
    expect(installed).toMatchObject({ id: "me.flow" });
    expect(calls).toEqual(["import flow.zip", "list"]);
    expect(view.api().importing).toBe(false);
    expect(errorToast).not.toHaveBeenCalled();
  } finally {
    errorToast.mockRestore();
    await view.cleanup();
  }
});

test("an import failure exposes localized inline feedback", async () => {
  const errorToast = spyOn(toast, "error");
  const view = await mount(null, {
    "POST /wallpaper-modules/import": () => new Response(
      JSON.stringify({ error: { code: "wallpaper_module_archive_invalid", message: "shader.frag: missing\nsee the docs" } }),
      { status: 400 },
    ),
  });
  try {
    let installed: WallpaperModuleListing | null = null;
    await view.act(async () => {
      installed = await view.api().importModule(new File(["z"], "bad.zip"));
    });
    expect(installed).toBeNull();
    expect(view.api().importError).toBe("That wallpaper file isn't valid.");
    expect(errorToast).not.toHaveBeenCalled();
  } finally {
    errorToast.mockRestore();
    await view.cleanup();
  }
});

test("an import failure without a message maps its code to inline feedback", async () => {
  const errorToast = spyOn(toast, "error");
  const view = await mount(null, {
    "POST /wallpaper-modules/import": () => new Response(JSON.stringify({ error: { code: "wallpaper_module_archive_too_large" } }), { status: 413 }),
  });
  try {
    await view.act(() => view.api().importModule(new File(["z"], "big.zip")));
    expect(view.api().importError).toBe("Modules up to 2 MB.");
    expect(errorToast).not.toHaveBeenCalled();
  } finally {
    errorToast.mockRestore();
    await view.cleanup();
  }
});

test("deleting a module refreshes the store; a conflict or other failure is a brief toast", async () => {
  const errorToast = spyOn(toast, "error");
  const view = await mount(null, {
    "DELETE /wallpaper-modules/me.flow": () => envelope({ id: "me.flow", deleted: true }),
    "GET /wallpaper-modules": () => envelope({ modules: [] }),
    "DELETE /wallpaper-modules/me.busy": () => new Response(JSON.stringify({ error: { code: "wallpaper_module_in_use" } }), { status: 409 }),
    "DELETE /wallpaper-modules/me.gone": () => new Response(JSON.stringify({ error: { code: "wallpaper_module_not_found" } }), { status: 404 }),
  });
  try {
    await view.act(() => view.api().deleteModule("me.flow"));
    await view.act(() => view.api().deleteModule("me.busy"));
    await view.act(() => view.api().deleteModule("me.gone"));
    expect(errorToast.mock.calls.map(([message]) => message)).toEqual(["Module in use.", "Module delete failed."]);
  } finally {
    errorToast.mockRestore();
    await view.cleanup();
  }
});
