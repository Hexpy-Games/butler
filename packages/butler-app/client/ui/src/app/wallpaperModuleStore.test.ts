/// <reference types="bun" />
import { expect, test } from "bun:test";
import { BUILTIN_WALLPAPERS, type WallpaperModule, type WallpaperModuleCheck } from "@/butler-ds";
import { createWallpaperModuleStore } from "./wallpaperModuleStore";
import type { WallpaperModuleListing, WallpaperModuleReport, WallpaperModuleStatus } from "./wallpaperModules";

const BUILTIN_IDS = BUILTIN_WALLPAPERS.list().map((module) => module.manifest.id);
const OK = "void main(){fragColor=vec4(1.);}";
const EDITED = "void main(){fragColor=vec4(.5);}";
const BROKEN = "void main(){fragColor=vec4(BROKEN);}";
const LOG = "ERROR: 0:1: 'BROKEN' : undeclared identifier";

function manifest(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: { en: id.slice(3), ko: id.slice(3) }, version: "0.1.0", engine: 1, motion: "animated", image: "none", params: [], ...extra };
}

function listing(id: string, status: WallpaperModuleStatus = { state: "unknown" }, extra: Record<string, unknown> = {}): WallpaperModuleListing {
  return { id, source: "user", status, manifest: manifest(id, extra) };
}

/** A gateway and GPU stand-in: `listings` and `shaders` are what the next refresh reads. */
function fixture() {
  const gateway = {
    listings: [] as WallpaperModuleListing[],
    shaders: {} as Record<string, string>,
    shaderReads: [] as string[],
    reports: [] as Array<[string, WallpaperModuleReport]>,
    revisions: [] as Array<string | undefined>,
    checks: [] as string[],
    failures: [] as string[],
    webgl2: true,
    /** Runs while a shader is being read (between a refresh reading its state and settling it). */
    duringRead: undefined as (() => void) | undefined,
  };
  const store = createWallpaperModuleStore({
    list: async () => [
      { id: "butler.bloom", source: "builtin", status: { state: "ok" }, manifest: manifest("butler.bloom") },
      ...gateway.listings,
    ],
    shader: async (id) => {
      gateway.shaderReads.push(id);
      await Promise.resolve();
      gateway.duringRead?.();
      const shader = gateway.shaders[id];
      if (shader === undefined) throw new Error("not found");
      return { text: shader, revision: `files-${shader.length}` };
    },
    report: async (id, report, revision) => {
      gateway.reports.push([id, report]);
      gateway.revisions.push(revision);
    },
    check: (module: WallpaperModule): WallpaperModuleCheck | null => {
      gateway.checks.push(module.manifest.id);
      if (!gateway.webgl2) return null;
      return module.fragment.includes("BROKEN") ? { ok: false, stage: "compile", log: LOG } : { ok: true };
    },
    notifyFailure: (module) => gateway.failures.push(module.id),
  });
  const ids = () => store.getSnapshot().registry.list().map((module) => module.manifest.id).filter((id) => !BUILTIN_IDS.includes(id));
  return { gateway, store, ids, user: () => store.getSnapshot().userModules };
}

test("bootstrap: built-ins plus usable user modules, in gateway order; checked verdicts are trusted", async () => {
  const { gateway, store, ids, user } = fixture();
  expect(store.getSnapshot().registry.list()).toEqual(BUILTIN_WALLPAPERS.list());
  gateway.listings = [listing("me.b", { state: "ok" }), listing("me.a", { state: "error", message: "Too slow\nmore" }), listing("me.c", { state: "ok" })];
  gateway.shaders = { "me.a": OK, "me.b": OK, "me.c": EDITED };
  await store.refresh();
  expect(ids()).toEqual(["me.b", "me.c"]);
  expect(store.getSnapshot().registry.list().slice(0, BUILTIN_IDS.length)).toEqual([...BUILTIN_WALLPAPERS.list()]);
  expect(user()).toEqual([
    { id: "me.b", name: { en: "b", ko: "b" } },
    { id: "me.a", name: { en: "a", ko: "a" }, error: "Too slow\nmore" },
    { id: "me.c", name: { en: "c", ko: "c" } },
  ]);
  expect(store.getSnapshot().registry.get("me.c")?.fragment).toBe(EDITED);
  expect(gateway.checks).toEqual([]);
  expect(gateway.reports).toEqual([]);
});

test("unchecked modules are compiled once and their verdict reported; failures keep the log", async () => {
  const { gateway, store, ids, user } = fixture();
  gateway.listings = [listing("me.good"), listing("me.bad")];
  gateway.shaders = { "me.good": OK, "me.bad": BROKEN };
  await store.refresh();
  expect(gateway.checks.sort()).toEqual(["me.bad", "me.good"]);
  expect(gateway.reports.sort()).toEqual([["me.bad", { state: "error", message: LOG }], ["me.good", { state: "ok" }]]);
  // Each report names the revision of the files it checked.
  expect(gateway.revisions.sort()).toEqual([`files-${BROKEN.length}`, `files-${OK.length}`].sort());
  expect(ids()).toEqual(["me.good"]);
  expect(user()[1]).toEqual({ id: "me.bad", name: { en: "bad", ko: "bad" }, error: LOG });
  // The gateway has not caught up yet: the same verdicts are not sent again.
  await store.refresh();
  expect(gateway.checks).toHaveLength(2);
  expect(gateway.reports).toHaveLength(2);
});

test("bad manifests and shaders are listed as failing with their errors", async () => {
  const { gateway, store, ids, user } = fixture();
  gateway.listings = [
    listing("me.future", { state: "unknown" }, { engine: 2 }),
    listing("me.known", { state: "error", message: "engine: must be 1" }, { engine: 2 }),
    listing("me.versioned"),
    listing("butler.silk"),
    { id: "me.nameless", source: "user", status: { state: "unknown" }, manifest: { id: "me.nameless" } },
  ];
  gateway.shaders = { "me.versioned": `#version 300 es\n${OK}`, "butler.silk": OK };
  await store.refresh();
  expect(ids()).toEqual([]);
  const errors = Object.fromEntries(user().map((entry) => [entry.id, entry.error?.split("\n")[0]]));
  expect(errors).toEqual({
    "me.future": "engine: must be 1",
    "me.known": "engine: must be 1",
    "me.versioned": "shader.frag: drop #version (the engine prelude sets it)",
    "butler.silk": "id: taken by a built-in module",
    "me.nameless": "name: needs non-empty en and ko",
  });
  expect(user().find((entry) => entry.id === "me.nameless")?.name).toBeUndefined();
  // Invalid manifests need no shader; the gateway already knew about me.known; a taken id is not the module's to report.
  expect(gateway.shaderReads.sort()).toEqual(["me.versioned"]);
  expect(gateway.reports.map(([id]) => id).sort()).toEqual(["me.future", "me.nameless", "me.versioned"]);
  expect(gateway.checks).toEqual([]);
});

test("a change event refetches only the named modules; an edited shader swaps in, an unchanged one is left alone", async () => {
  const { gateway, store, ids } = fixture();
  gateway.listings = [listing("me.flow", { state: "ok" }), listing("me.other", { state: "ok" })];
  gateway.shaders = { "me.flow": OK, "me.other": OK };
  await store.refresh();
  const before = store.getSnapshot();
  gateway.shaderReads = [];
  gateway.shaders["me.flow"] = EDITED;
  gateway.shaders["me.other"] = EDITED;
  await store.refresh(["me.flow"]);
  expect(gateway.shaderReads).toEqual(["me.flow"]);
  expect(gateway.checks).toEqual(["me.flow"]);
  // It compiles and the gateway already says ok: nothing to report.
  expect(gateway.reports).toEqual([]);
  const after = store.getSnapshot();
  expect(after.registry).not.toBe(before.registry);
  expect(after.registry.get("me.flow")?.fragment).toBe(EDITED);
  expect(after.registry.get("me.other")).toBe(before.registry.get("me.other"));
  // The same content again (e.g. a touched file): no check, no report, no new registry.
  await store.refresh(["me.flow"]);
  expect(gateway.checks).toEqual(["me.flow"]);
  expect(store.getSnapshot()).toBe(after);
  expect(ids()).toEqual(["me.flow", "me.other"]);
});

test("an edit that breaks a module retires it once; fixing it brings it back", async () => {
  const { gateway, store, ids, user } = fixture();
  gateway.listings = [listing("me.flow", { state: "ok" })];
  gateway.shaders = { "me.flow": OK };
  await store.refresh();
  gateway.shaders["me.flow"] = BROKEN;
  await store.refresh(["me.flow"]);
  expect(ids()).toEqual([]);
  expect(user()).toEqual([{ id: "me.flow", name: { en: "flow", ko: "flow" }, error: LOG }]);
  expect(gateway.reports).toEqual([["me.flow", { state: "error", message: LOG }]]);
  gateway.listings = [listing("me.flow", { state: "error", message: LOG })];
  await store.refresh(["me.flow"]);
  expect(gateway.reports).toHaveLength(1);
  gateway.shaders["me.flow"] = OK;
  await store.refresh(["me.flow"]);
  expect(ids()).toEqual(["me.flow"]);
  expect(gateway.reports.at(-1)).toEqual(["me.flow", { state: "ok" }]);
});

test("removed modules leave the registry and the list", async () => {
  const { gateway, store, ids, user } = fixture();
  gateway.listings = [listing("me.flow", { state: "ok" })];
  gateway.shaders = { "me.flow": OK };
  await store.refresh();
  gateway.listings = [];
  await store.refresh(["me.flow"]);
  expect(ids()).toEqual([]);
  expect(user()).toEqual([]);
});

test("without WebGL2 modules stay usable and nothing is reported", async () => {
  const { gateway, store, ids } = fixture();
  gateway.webgl2 = false;
  gateway.listings = [listing("me.flow")];
  gateway.shaders = { "me.flow": OK };
  await store.refresh();
  expect(ids()).toEqual(["me.flow"]);
  expect(gateway.reports).toEqual([]);
});

test("runtime failures retire a user module once: too slow, context lost or failing to compile when drawn", async () => {
  const { gateway, store, ids, user } = fixture();
  gateway.listings = [listing("me.slow", { state: "ok" }), listing("me.lost", { state: "ok" }), listing("me.late", { state: "ok" })];
  gateway.shaders = { "me.slow": OK, "me.lost": OK, "me.late": OK };
  await store.refresh();
  store.handleError({ reason: "degraded", module: "me.slow", message: "Frames too slow; holding a still frame" });
  store.handleError({ reason: "degraded", module: "me.slow", message: "Frames too slow; holding a still frame" });
  store.handleError({ reason: "context-lost", module: "me.lost", message: "WebGL context lost while drawing" });
  store.handleError({ reason: "compile", module: "me.late", message: `${LOG}\n\0` });
  // Built-ins and failures that are not the module's are ignored.
  store.handleError({ reason: "degraded", module: "butler.bloom", message: "Frames too slow; holding a still frame" });
  store.handleError({ reason: "image-load", module: "butler.image", asset: "wp_1", message: "404" });
  expect(ids()).toEqual([]);
  expect(user().map((entry) => entry.error)).toEqual(["Frames too slow; holding a still frame", "WebGL context lost while drawing", LOG]);
  expect(gateway.reports).toEqual([
    ["me.slow", { state: "error", message: "Frames too slow; holding a still frame" }],
    ["me.lost", { state: "error", message: "WebGL context lost while drawing" }],
    ["me.late", { state: "error", message: LOG }],
  ]);
  // A runtime verdict holds until the module changes: the next refresh keeps it.
  gateway.listings = [listing("me.slow", { state: "error", message: "Frames too slow; holding a still frame" })];
  await store.refresh(["me.slow"]);
  expect(ids()).toEqual([]);
  expect(gateway.checks).toEqual([]);
});

test("a shown module that stops working falls back with one notice per change", async () => {
  const { gateway, store } = fixture();
  gateway.listings = [listing("me.flow", { state: "ok" })];
  gateway.shaders = { "me.flow": OK };
  await store.refresh();
  // Not known yet (still loading) or usable: nothing to say.
  store.handleError({ reason: "unknown-module", module: "me.later", message: "Unknown wallpaper module me.later" });
  gateway.shaders["me.flow"] = BROKEN;
  await store.refresh(["me.flow"]);
  // The wallpaper showing it re-resolves against the new registry and falls back.
  store.handleError({ reason: "unknown-module", module: "me.flow", message: "Unknown wallpaper module me.flow" });
  store.handleError({ reason: "unknown-module", module: "me.flow", message: "Unknown wallpaper module me.flow" });
  expect(gateway.failures).toEqual(["me.flow"]);
  gateway.shaders["me.flow"] = `${BROKEN}// again`;
  await store.refresh(["me.flow"]);
  store.handleError({ reason: "unknown-module", module: "me.flow", message: "Unknown wallpaper module me.flow" });
  expect(gateway.failures).toEqual(["me.flow", "me.flow"]);
});

test("refreshes coalesce: one runs, the next waits and covers every named module", async () => {
  const { gateway, store } = fixture();
  let lists = 0;
  gateway.listings = [listing("me.a", { state: "ok" }), listing("me.b", { state: "ok" })];
  gateway.shaders = { "me.a": OK, "me.b": OK };
  await store.refresh();
  gateway.shaderReads = [];
  const original = gateway.listings;
  Object.defineProperty(gateway, "listings", { get: () => { lists += 1; return original; } });
  await Promise.all([store.refresh(["me.a"]), store.refresh(["me.a"]), store.refresh(["me.b"])]);
  // The first refresh runs alone; the two that arrive meanwhile share the next run.
  expect(lists).toBe(2);
  expect(gateway.shaderReads.sort()).toEqual(["me.a", "me.a", "me.b"]);
});

test("a gateway that cannot list keeps what is loaded", async () => {
  const { gateway, store, ids } = fixture();
  gateway.listings = [listing("me.flow", { state: "ok" })];
  gateway.shaders = { "me.flow": OK };
  await store.refresh();
  Object.defineProperty(gateway, "listings", { get: () => { throw new Error("offline"); } });
  await store.refresh();
  expect(ids()).toEqual(["me.flow"]);
});

test("a failure when drawn during a refresh is not undone by that refresh", async () => {
  const { gateway, store, ids } = fixture();
  gateway.listings = [listing("me.flow", { state: "ok" })];
  gateway.shaders = { "me.flow": OK };
  await store.refresh();
  gateway.duringRead = () => store.handleError({ reason: "degraded", module: "me.flow", message: "Frames too slow; holding a still frame" });
  await store.refresh(["me.flow"]);
  expect(ids()).toEqual([]);
  expect(gateway.reports).toEqual([["me.flow", { state: "error", message: "Frames too slow; holding a still frame" }]]);
});
