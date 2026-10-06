/// <reference types="bun" />
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createWallpaperEngine } from "./engine";
import { defineWallpaperModule } from "./manifest";
import { BUILTIN_WALLPAPERS, createWallpaperRegistry, resolveWallpaperScene } from "./registry";
import { WALLPAPER_WATCHDOG_RETRY_MS, WALLPAPER_WATCHDOG_SLOW_FRAMES, WALLPAPER_WATCHDOG_SLOW_RENDER_MS } from "./scheduler";
import type { WallpaperError, WallpaperImageLoader, WallpaperSource } from "./types";

let frames: Array<(time: number) => void> = [];
let draws = 0;
let contentRects: number[][] = [];
/** Scalar/vec3 uniform uploads in order (name, value). */
let uploads: Array<[string, unknown]> = [];
let windowTarget: EventTarget;
let documentTarget: EventTarget & { visibilityState: string; hasFocus: () => boolean };
const saved = { window: globalThis.window, document: globalThis.document };

let fades: Keyframe[][] = [];
let lostContexts = 0;
/** `performance.now()` for the engine; each draw call advances it by `drawCost` (render time). */
let fakeNow = 0;
let drawCost = 0;
let timers: Array<{ callback: () => void; ms: number }> = [];
let performanceNow: { mockRestore(): void } | null = null;

function fakeCanvas({ unused = ["u_dayPhase"], renderer = "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro)" }: { unused?: string[]; renderer?: string } = {}): HTMLCanvasElement {
  const gl = new Proxy({
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: (_program: unknown, name: string) => (unused.includes(name) ? null : name),
    getShaderPrecisionFormat: () => ({ precision: 23 }),
    uniform4f: (location: string, ...value: number[]) => { if (location === "u_contentRect") contentRects.push(value); },
    uniform1f: (location: string, value: number) => uploads.push([location, value]),
    uniform3fv: (location: string, value: Float32Array) => uploads.push([location, [...value]]),
    drawArrays: () => { draws += 1; fakeNow += drawCost; },
    getExtension: (name: string) => (name === "WEBGL_lose_context" ? { loseContext: () => { lostContexts += 1; } } : null),
    getParameter: () => renderer,
  } as Record<string, unknown>, { get: (target, key) => target[key as string] ?? (() => ({})) });
  return Object.assign(new EventTarget(), {
    width: 0,
    height: 0,
    style: { visibility: "" },
    dataset: {} as Record<string, string>,
    getContext: () => gl,
    animate: (keyframes: Keyframe[]) => {
      fades.push(keyframes);
      return { cancel: () => undefined };
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 50 }),
  }) as unknown as HTMLCanvasElement;
}

beforeEach(() => {
  fades = [];
  lostContexts = 0;
  fakeNow = 0;
  drawCost = 0;
  timers = [];
  performanceNow = spyOn(performance, "now").mockImplementation(() => fakeNow);
  frames = [];
  draws = 0;
  contentRects = [];
  uploads = [];
  windowTarget = new EventTarget();
  documentTarget = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => true, body: null });
  globalThis.window = Object.assign(windowTarget, {
    devicePixelRatio: 2,
    innerWidth: 100,
    innerHeight: 50,
    requestAnimationFrame: (callback: (time: number) => void) => frames.push(callback),
    cancelAnimationFrame: () => undefined,
    setTimeout: (callback: () => void, ms: number) => timers.push({ callback, ms }),
    clearTimeout: () => undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
  }) as unknown as typeof window;
  globalThis.document = documentTarget as unknown as Document;
});

afterEach(() => {
  performanceNow?.mockRestore();
  globalThis.window = saved.window;
  globalThis.document = saved.document;
});

/** Runs the pending animation frame at `time`; returns whether one was pending. */
function step(time: number): boolean {
  const pending = frames.splice(0);
  for (const callback of pending) callback(time);
  return pending.length > 0;
}

// A static module standing in for every change-driven wallpaper.
const STILL = defineWallpaperModule({
  manifest: { id: "me.still", name: { en: "Still", ko: "정지" }, version: "0.1.0", engine: 1, motion: "static", image: "none", params: [] },
  fragment: "void main(){fragColor=vec4(u_contentRect.xy,0.,1.);}",
});
const REGISTRY = createWallpaperRegistry([...BUILTIN_WALLPAPERS.list(), STILL]);

function sceneOf(source: WallpaperSource) {
  return resolveWallpaperScene(source, REGISTRY, "light");
}

function start(source: WallpaperSource = { kind: "live", module: "butler.bloom" }) {
  const engine = createWallpaperEngine(fakeCanvas(), { onError: () => undefined })!;
  engine.setScene(sceneOf(source));
  return engine;
}

test("animated modules loop at no more than 20fps", () => {
  start();
  for (let time = 0; time <= 1000; time += 1000 / 60) step(time);
  expect(draws).toBeGreaterThanOrEqual(19);
  expect(draws).toBeLessThanOrEqual(21);
});

test("software GL holds still frames for animated modules and marks the canvas before the first frame", () => {
  const canvas = fakeCanvas({ renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)" });
  const engine = createWallpaperEngine(canvas, { onError: () => undefined })!;
  expect(canvas.dataset.wallpaperFallback).toBe("software");
  engine.setScene(sceneOf({ kind: "live", module: "butler.bloom" }));
  step(0);
  expect(draws).toBe(1);
  expect(step(100)).toBe(false);
  expect(draws).toBe(1);
  const hardware = fakeCanvas();
  createWallpaperEngine(hardware, { onError: () => undefined });
  expect(hardware.dataset.wallpaperFallback).toBeUndefined();
  // A test harness opts out: software GL animates.
  (documentTarget as unknown as { documentElement: { dataset: Record<string, string> } }).documentElement = { dataset: { wallpaperSoftwareFallback: "off" } };
  const optedOut = fakeCanvas({ renderer: "SwiftShader" });
  createWallpaperEngine(optedOut, { onError: () => undefined });
  expect(optedOut.dataset.wallpaperFallback).toBeUndefined();
});

test("the user's pause holds a still frame and stops the loop", () => {
  const engine = start();
  step(0);
  expect(draws).toBe(1);
  engine.setMotion("paused", false);
  step(100);
  expect(step(200)).toBe(false);
  expect(draws).toBe(1);
  engine.setMotion("auto", false);
  step(300);
  expect(draws).toBe(2);
});

test("a visible but unfocused window keeps animating", () => {
  documentTarget.hasFocus = () => false;
  start();
  windowTarget.dispatchEvent(new Event("blur"));
  for (let time = 0; time <= 1000; time += 1000 / 60) step(time);
  expect(draws).toBeGreaterThanOrEqual(19);
  expect(step(1050)).toBe(true);
});

test("a hidden document renders nothing until it is visible again", () => {
  start();
  documentTarget.visibilityState = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  step(0);
  expect(step(50)).toBe(false);
  expect(draws).toBe(0);
  documentTarget.visibilityState = "visible";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  step(100);
  expect(draws).toBe(1);
});

test("static modules draw once per change", () => {
  const engine = start({ kind: "live", module: "me.still" });
  step(0);
  expect(step(50)).toBe(false);
  expect(draws).toBe(1);
  engine.setScene(sceneOf({ kind: "live", module: "me.still", params: {} }));
  step(100);
  expect(draws).toBe(2);
});

test("a content rect change redraws a still frame in drawing-buffer px when the module reads it", () => {
  const image = { kind: "live", module: "me.still" } as const;
  const engine = createWallpaperEngine(fakeCanvas(), { onError: () => undefined })!;
  engine.setScene(sceneOf(image));
  step(0);
  expect(contentRects.at(-1)).toEqual([0, 0, 0, 0]);
  // 100×50 CSS canvas at DPR 2 (static policy): 10,5 40×20 → x 20, y (50-25)*2, 80×40.
  engine.setContentRect({ x: 10, y: 5, width: 40, height: 20 });
  step(50);
  expect(draws).toBe(2);
  expect(contentRects.at(-1)).toEqual([20, 50, 80, 40]);
  engine.setContentRect(null);
  step(100);
  expect(contentRects.at(-1)).toEqual([0, 0, 0, 0]);

  const blind = createWallpaperEngine(fakeCanvas({ unused: ["u_dayPhase", "u_contentRect"] }), { onError: () => undefined })!;
  blind.setScene(sceneOf(image));
  step(150);
  const before = draws;
  blind.setContentRect({ x: 10, y: 5, width: 40, height: 20 });
  expect(step(200)).toBe(false);
  expect(draws).toBe(before);
});

test("a lost context stops drawing; restoring it redraws", () => {
  const canvas = fakeCanvas();
  const engine = createWallpaperEngine(canvas, { onError: () => undefined })!;
  engine.setScene(sceneOf({ kind: "live", module: "butler.silk" }));
  engine.setMotion("paused", false);
  step(0);
  expect(draws).toBe(1);
  const lost = new Event("webglcontextlost", { cancelable: true });
  canvas.dispatchEvent(lost);
  expect(lost.defaultPrevented).toBe(true);
  step(50);
  expect(draws).toBe(1);
  canvas.dispatchEvent(new Event("webglcontextrestored"));
  step(100);
  expect(draws).toBe(2);
});

test("the watchdog degrades slow renders to a still frame, ignores long frame gaps, and retries after a quiet period", () => {
  start();
  let time = 0;
  // Main-thread stalls stretch the gaps between frames: not the wallpaper's fault.
  for (let frame = 0; frame < WALLPAPER_WATCHDOG_SLOW_FRAMES * 2; frame += 1) {
    time += 1000;
    step(time);
  }
  time += 1000;
  expect(step(time)).toBe(true);
  drawCost = WALLPAPER_WATCHDOG_SLOW_RENDER_MS + 1;
  for (let frame = 0; frame < WALLPAPER_WATCHDOG_SLOW_FRAMES; frame += 1) {
    time += 100;
    step(time);
  }
  const before = draws;
  step(time + 16);
  expect(step(time + 32)).toBe(false);
  expect(draws).toBe(before);
  const retry = timers.find(({ ms }) => ms === WALLPAPER_WATCHDOG_RETRY_MS);
  expect(retry).toBeDefined();
  drawCost = 0;
  retry!.callback();
  step(time + 200);
  expect(step(time + 300)).toBe(true);
  expect(draws).toBeGreaterThan(before);
});

test("the watchdog and a lost context report the module drawn, once each", () => {
  const errors: WallpaperError[] = [];
  const canvas = fakeCanvas();
  const engine = createWallpaperEngine(canvas, { onError: (error) => errors.push(error) })!;
  engine.setScene(sceneOf({ kind: "live", module: "butler.bloom" }));
  let time = 0;
  drawCost = WALLPAPER_WATCHDOG_SLOW_RENDER_MS + 1;
  for (let frame = 0; frame < WALLPAPER_WATCHDOG_SLOW_FRAMES * 2; frame += 1) {
    time += 100;
    step(time);
  }
  canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  expect(errors.map(({ reason, module }) => [reason, module])).toEqual([["degraded", "butler.bloom"], ["context-lost", "butler.bloom"]]);
  expect(errors.every(({ message }) => message.length > 0)).toBe(true);
});

test("a lost context with nothing drawn reports nothing", () => {
  const errors: WallpaperError[] = [];
  const canvas = fakeCanvas();
  createWallpaperEngine(canvas, { onError: (error) => errors.push(error) });
  canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  expect(errors).toEqual([]);
});

test("unknown modules and missing WebGL2 report through onError", () => {
  const errors: string[] = [];
  const engine = createWallpaperEngine(fakeCanvas(), { onError: (error) => errors.push(error.reason) })!;
  engine.setScene(sceneOf({ kind: "live", module: "me.gone" }));
  const canvas = Object.assign(new EventTarget(), { getContext: () => null }) as unknown as HTMLCanvasElement;
  expect(createWallpaperEngine(canvas, { onError: (error) => errors.push(error.reason) })).toBeNull();
  expect(errors).toEqual(["unknown-module", "unsupported"]);
});

const IMAGE_A: WallpaperSource = { kind: "image", asset: "a", fit: "cover", dim: 0, blur: 0 };
const BITMAP = { width: 200, height: 100, close: () => undefined } as unknown as ImageBitmap;
/** Lets pending loads and decodes settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function lastUpload(name: string) {
  return uploads.filter(([location]) => location === name).at(-1)?.[1];
}

interface FakeAnimation { keyframes: Keyframe[]; onfinish: (() => void) | null; cancel: () => void }

function fakeOverlay() {
  const overlay = {
    width: 0,
    height: 0,
    hidden: true,
    snapshots: 0,
    animations: [] as FakeAnimation[],
    getContext: () => ({ drawImage: () => { overlay.snapshots += 1; } }),
    animate: (keyframes: Keyframe[]) => {
      const animation: FakeAnimation = { keyframes, onfinish: null, cancel: () => undefined };
      overlay.animations.push(animation);
      return animation;
    },
  };
  return overlay;
}

function imageEngine({ imageLoader, errors = [], overlay = null, decodes = { count: 0 } }: {
  imageLoader?: WallpaperImageLoader;
  errors?: WallpaperError[];
  overlay?: ReturnType<typeof fakeOverlay> | null;
  decodes?: { count: number };
}) {
  const canvas = fakeCanvas();
  const decode = async () => {
    decodes.count += 1;
    return BITMAP;
  };
  const engine = createWallpaperEngine(canvas, {
    onError: (error) => errors.push(error),
    imageLoader,
    decode,
    overlay: overlay as unknown as HTMLCanvasElement | null,
  })!;
  return { canvas, engine };
}

function recordingLoader(calls: string[][]): WallpaperImageLoader {
  return (asset, variant) => {
    calls.push([asset, variant]);
    return Promise.resolve(new Blob([asset]));
  };
}

test("image sources load once through the injected loader and draw when ready", async () => {
  const calls: string[][] = [];
  const { engine } = imageEngine({ imageLoader: recordingLoader(calls) });
  engine.setScene(sceneOf(IMAGE_A));
  // A 100×50 CSS canvas at DPR 2 (static policy) is 200×100: the thumbnail is enough.
  expect(calls).toEqual([["a", "thumbnail"]]);
  step(0);
  expect(lastUpload("u_hasImage")).toBe(0);
  await settle();
  step(50);
  expect(lastUpload("u_hasImage")).toBe(1);
  // Option changes redraw with the uploaded texture (dim is its own pass).
  engine.setScene(sceneOf({ ...IMAGE_A, dim: 0.5, blur: 0.3 } as WallpaperSource));
  step(100);
  expect(lastUpload("u_brightness")).toBe(0.5);
  expect(lastUpload("u_hasImage")).toBe(1);
  expect(calls).toHaveLength(1);
});

test("the previous wallpaper stays until the image is ready, then crossfades", async () => {
  const overlay = fakeOverlay();
  let resolve: (blob: Blob) => void = () => undefined;
  const { engine } = imageEngine({ overlay, imageLoader: () => new Promise<Blob>((done) => { resolve = done; }) });
  engine.setScene(sceneOf({ kind: "live", module: "butler.silk" }));
  engine.setMotion("paused", false);
  step(0);
  expect(draws).toBe(1);
  engine.setScene(sceneOf(IMAGE_A));
  expect(step(50)).toBe(false);
  expect(draws).toBe(1);
  resolve(new Blob(["a"]));
  await settle();
  expect(overlay.snapshots).toBe(1);
  expect(overlay.hidden).toBe(false);
  expect(overlay.animations.map((animation) => animation.keyframes)).toEqual([[{ opacity: 0 }]]);
  // The snapshot repainted the previous frame (the drawing buffer is not preserved).
  expect(draws).toBe(2);
  step(100);
  expect(draws).toBe(3);
  expect(lastUpload("u_hasImage")).toBe(1);
  overlay.animations[0]!.onfinish?.();
  expect(overlay.hidden).toBe(true);
  expect(overlay.width).toBe(0);
});

test("a failed image load falls back to the default module and reports it", async () => {
  const errors: WallpaperError[] = [];
  const { engine } = imageEngine({ errors, imageLoader: () => Promise.reject(new Error("404")) });
  engine.setScene(sceneOf(IMAGE_A));
  step(0);
  await settle();
  step(50);
  expect(errors).toEqual([{ reason: "image-load", module: "butler.image", asset: "a", message: "404" }]);
  expect(lastUpload("p_colors")).toBeDefined();
});

test("without an imageLoader, image sources fall back to the default module", async () => {
  const errors: WallpaperError[] = [];
  const { engine } = imageEngine({ errors });
  engine.setScene(sceneOf(IMAGE_A));
  await settle();
  expect(errors.map((error) => error.reason)).toEqual(["image-load"]);
});

test("a restored context re-uploads the visible image without loading it again", async () => {
  const calls: string[][] = [];
  const decodes = { count: 0 };
  const { canvas, engine } = imageEngine({ imageLoader: recordingLoader(calls), decodes });
  engine.setScene(sceneOf(IMAGE_A));
  await settle();
  step(0);
  canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  canvas.dispatchEvent(new Event("webglcontextrestored"));
  step(50);
  expect(lastUpload("u_hasImage")).toBe(0);
  await settle();
  step(100);
  expect(lastUpload("u_hasImage")).toBe(1);
  expect(decodes.count).toBe(2);
  expect(calls).toHaveLength(1);
});

test("an image no scene uses is released; showing it again loads it again", async () => {
  const calls: string[][] = [];
  const { engine } = imageEngine({ imageLoader: recordingLoader(calls) });
  engine.setScene(sceneOf(IMAGE_A));
  await settle();
  engine.setScene(sceneOf({ kind: "live", module: "butler.silk" }));
  engine.setScene(sceneOf(IMAGE_A));
  await settle();
  expect(calls).toEqual([["a", "thumbnail"], ["a", "thumbnail"]]);
});

test("none fades the last frame out and frees the canvas; the next scene fades in", () => {
  const overlay = fakeOverlay();
  const { canvas, engine } = imageEngine({ overlay });
  engine.setScene(sceneOf({ kind: "live", module: "butler.silk" }));
  engine.setMotion("paused", false);
  step(0);
  expect([canvas.width, canvas.height]).toEqual([100, 50]);
  engine.setScene(null);
  expect(overlay.snapshots).toBe(1);
  expect(overlay.animations.map((animation) => animation.keyframes)).toEqual([[{ opacity: 0 }]]);
  // Nothing draws, the canvas hides and its drawing buffer is released: the page shows through.
  expect([canvas.width, canvas.height, canvas.style.visibility]).toEqual([0, 0, "hidden"]);
  step(50);
  expect(step(60)).toBe(false);
  // Only the snapshot's repaint of the last frame.
  expect(draws).toBe(2);
  engine.setScene(sceneOf({ kind: "live", module: "butler.bloom" }));
  // Still hidden until the first frame is on the canvas, then it fades in.
  expect([canvas.style.visibility, fades]).toEqual(["hidden", []]);
  step(100);
  expect(draws).toBe(3);
  expect([canvas.style.visibility, fades]).toEqual(["", [[{ opacity: 0, offset: 0 }]]]);
  expect(overlay.snapshots).toBe(1);
});

test("a param or tone change redraws in place; another module crossfades", () => {
  const overlay = fakeOverlay();
  const { engine } = imageEngine({ overlay });
  engine.setScene(sceneOf({ kind: "live", module: "butler.bloom" }));
  engine.setMotion("paused", false);
  step(0);
  engine.setScene(sceneOf({ kind: "live", module: "butler.bloom", params: { colors: "aurora" } }));
  expect(overlay.snapshots).toBe(0);
  engine.setScene(resolveWallpaperScene({ kind: "live", module: "butler.bloom", params: { colors: "aurora" } }, REGISTRY, "dark"));
  expect(overlay.snapshots).toBe(0);
  step(50);
  expect(draws).toBe(2);
  engine.setScene(sceneOf({ kind: "live", module: "butler.silk" }));
  expect(overlay.snapshots).toBe(1);
});

test("a hot reload (a new registry with the module's new shader) crossfades to it", () => {
  const overlay = fakeOverlay();
  const { engine } = imageEngine({ overlay });
  const edited = defineWallpaperModule({ manifest: STILL.manifest, fragment: "void main(){fragColor=vec4(.5);}" });
  engine.setScene(sceneOf({ kind: "live", module: "me.still" }));
  step(0);
  const reloaded = createWallpaperRegistry([...BUILTIN_WALLPAPERS.list(), edited]);
  engine.setScene(resolveWallpaperScene({ kind: "live", module: "me.still" }, reloaded, "light"));
  expect(overlay.snapshots).toBe(1);
  step(50);
  // The first frame, the snapshot's repaint, the new shader.
  expect(draws).toBe(3);
});

test("dispose gives the WebGL context back", () => {
  const engine = start();
  step(0);
  engine.dispose();
  expect(lostContexts).toBe(1);
});
