/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import {
  deleteWallpaperModule,
  importWallpaperModule,
  listWallpaperModules,
  readWallpaperModuleShader,
  reportWallpaperModuleStatus,
  wallpaperModuleInUse,
  wallpaperModulesChanged,
} from "./wallpaperModules";

const saved = { fetch: globalThis.fetch, window: Object.getOwnPropertyDescriptor(globalThis, "window") };
afterEach(() => {
  globalThis.fetch = saved.fetch;
  if (saved.window) Object.defineProperty(globalThis, "window", saved.window); else Reflect.deleteProperty(globalThis, "window");
});

const FLOW = { id: "me.flow", name: { en: "Flow", ko: "흐름" }, version: "0.1.0", engine: 1, motion: "animated", image: "none", params: [] };
const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ protocol_version: "butler.app.v1", data }), { status });

type Call = { url: string; method: string; body?: unknown };

function browser(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: String(input), method, body: init?.body });
    const route = routes[`${method} ${String(input)}`];
    return route ? route() : new Response("{}", { status: 404 });
  }) as typeof fetch;
  return calls;
}

test("listings split into id, source, status and the manifest; missing fields read as built-in and unchecked", async () => {
  browser({
    "GET /wallpaper-modules": () => envelope({
      modules: [
        { ...FLOW, source: "user", status: { state: "error", message: "ERROR: 0:1: x", checkedAt: "2026-09-28T01:00:00Z" } },
        { id: "butler.bloom", name: { en: "Bloom", ko: "블룸" } },
        { name: "no id" },
      ],
    }),
  });
  expect(await listWallpaperModules()).toEqual([
    { id: "me.flow", source: "user", status: { state: "error", message: "ERROR: 0:1: x", checkedAt: "2026-09-28T01:00:00Z" }, manifest: FLOW },
    { id: "butler.bloom", source: "builtin", status: { state: "unknown" }, manifest: { id: "butler.bloom", name: { en: "Bloom", ko: "블룸" } } },
  ]);
});

test("browser mode: shader text and status reports over same-origin fetch", async () => {
  const calls = browser({
    "GET /wallpaper-modules/me.flow/shader": () => new Response("void main(){}", { headers: { "content-type": "text/plain", etag: "\"r1\"" } }),
    "POST /wallpaper-modules/me.flow/status": () => envelope({ id: "me.flow", status: { state: "error" } }),
    "GET /wallpaper-modules/me.gone/shader": () => new Response(JSON.stringify({ error: { code: "wallpaper_module_not_found" } }), { status: 404 }),
  });
  expect(await readWallpaperModuleShader("me.flow")).toEqual({ text: "void main(){}", revision: "r1" });
  await reportWallpaperModuleStatus("me.flow", { state: "error", message: "ERROR: 0:1: x" }, "r1");
  await expect(readWallpaperModuleShader("me.gone")).rejects.toMatchObject({ code: "wallpaper_module_not_found", status: 404 });
  expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
    "GET /wallpaper-modules/me.flow/shader", "POST /wallpaper-modules/me.flow/status", "GET /wallpaper-modules/me.gone/shader",
  ]);
  expect(JSON.parse(String(calls[1]?.body))).toEqual({ state: "error", message: "ERROR: 0:1: x", revision: "r1" });
});

test("desktop mode: the preload bridge carries list, shader and status", async () => {
  const calls: Array<[string, unknown]> = [];
  const bridge = {
    listWallpaperModules: async () => { calls.push(["listWallpaperModules", undefined]); return { ok: true, data: { modules: [{ ...FLOW, source: "user", status: { state: "ok" } }] } }; },
    readWallpaperModuleShader: async (input: unknown) => { calls.push(["readWallpaperModuleShader", input]); return { ok: true, data: { text: "void main(){}", revision: "\"r2\"" } }; },
    reportWallpaperModuleStatus: async (input: unknown) => { calls.push(["reportWallpaperModuleStatus", input]); return { ok: false, error: { code: "wallpaper_module_not_found", status: 404 } }; },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { butlerApp: bridge } });
  globalThis.fetch = (() => Promise.reject(new Error("fetch must not be used"))) as unknown as typeof fetch;
  expect((await listWallpaperModules()).map(({ id, source }) => [id, source])).toEqual([["me.flow", "user"]]);
  expect(await readWallpaperModuleShader("me.flow")).toEqual({ text: "void main(){}", revision: "r2" });
  await expect(reportWallpaperModuleStatus("me.flow", { state: "ok" }, "r2")).rejects.toMatchObject({ code: "wallpaper_module_not_found" });
  expect(calls).toEqual([
    ["listWallpaperModules", undefined],
    ["readWallpaperModuleShader", { id: "me.flow" }],
    ["reportWallpaperModuleStatus", { id: "me.flow", state: "ok", revision: "r2" }],
  ]);
});

test("wallpaper.modules.updated names the changed modules; other events are not about modules", () => {
  expect(wallpaperModulesChanged({ type: "wallpaper.modules.updated", payload: { ids: ["me.flow", 3, "me.rain"] } as never })).toEqual(["me.flow", "me.rain"]);
  // No ids: something changed, reload everything.
  expect(wallpaperModulesChanged({ type: "wallpaper.modules.updated" })).toEqual([]);
  expect(wallpaperModulesChanged({ type: "settings.updated", payload: {} })).toBeNull();
});

test("browser mode: importing a zip installs the module; deleting it goes to the gateway", async () => {
  const calls = browser({
    "POST /wallpaper-modules/import": () => envelope({ ...FLOW, source: "user", status: { state: "unknown" } }, 201),
    "DELETE /wallpaper-modules/me.flow": () => envelope({ id: "me.flow", deleted: true }),
  });
  const file = new File(["zip bytes"], "flow.zip", { type: "application/zip" });
  expect(await importWallpaperModule(file)).toEqual({ id: "me.flow", source: "user", status: { state: "unknown" }, manifest: FLOW });
  expect((calls[0]?.body as FormData).get("file")).toBeInstanceOf(File);
  await deleteWallpaperModule("me.flow");
  expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual(["POST /wallpaper-modules/import", "DELETE /wallpaper-modules/me.flow"]);
});

test("browser mode: an import failure keeps the gateway's own message; a delete conflict is wallpaper_module_in_use", async () => {
  browser({
    "POST /wallpaper-modules/import": () => new Response(JSON.stringify({ error: { code: "wallpaper_module_archive_invalid", message: "shader.frag: missing\nsee docs" } }), { status: 400 }),
    "DELETE /wallpaper-modules/me.flow": () => new Response(JSON.stringify({ error: { code: "wallpaper_module_in_use" } }), { status: 409 }),
  });
  await expect(importWallpaperModule(new File(["x"], "x.zip"))).rejects.toMatchObject({
    code: "wallpaper_module_archive_invalid", status: 400, message: "shader.frag: missing\nsee docs",
  });
  const conflict = await deleteWallpaperModule("me.flow").then(() => null, (error) => error);
  expect(wallpaperModuleInUse(conflict)).toBe(true);
  expect(wallpaperModuleInUse(new Error("other"))).toBe(false);
});

test("desktop mode: the preload bridge carries import and delete", async () => {
  const calls: Array<[string, unknown]> = [];
  const bridge = {
    importWallpaperModule: async (input: { name: string; bytes: ArrayBuffer }) => {
      calls.push(["importWallpaperModule", { name: input.name, size: input.bytes.byteLength }]);
      return { ok: true, data: { ...FLOW, source: "user", status: { state: "unknown" } } };
    },
    deleteWallpaperModule: async (input: unknown) => {
      calls.push(["deleteWallpaperModule", input]);
      return { ok: false, error: { code: "wallpaper_module_in_use", status: 409 } };
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { butlerApp: bridge } });
  globalThis.fetch = (() => Promise.reject(new Error("fetch must not be used"))) as unknown as typeof fetch;
  expect((await importWallpaperModule(new File(["z"], "flow.zip"))).id).toBe("me.flow");
  await expect(deleteWallpaperModule("me.flow")).rejects.toMatchObject({ code: "wallpaper_module_in_use", status: 409 });
  expect(calls).toEqual([
    ["importWallpaperModule", { name: "flow.zip", size: 1 }],
    ["deleteWallpaperModule", { id: "me.flow" }],
  ]);
});
