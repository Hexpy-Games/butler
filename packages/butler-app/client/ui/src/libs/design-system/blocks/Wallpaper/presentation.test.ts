// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { BLOOM_WALLPAPER, SILK_WALLPAPER } from "./modules";
import { EMPTY_WALLPAPER_PRESENTATION, stepWallpaperPresentation, type WallpaperPresentation } from "./presentation";
import { defineWallpaperModule } from "./manifest";
import { BUILTIN_WALLPAPERS, createWallpaperRegistry, resolveWallpaperScene } from "./registry";
import type { WallpaperSource } from "./types";

function scene(source: WallpaperSource, tone: "light" | "dark" = "light") {
  return resolveWallpaperScene(source, BUILTIN_WALLPAPERS, tone)!;
}

const SILK = scene({ kind: "live", module: "butler.silk" });
const BLOOM = scene({ kind: "live", module: "butler.bloom" });
const IMAGE_A = scene({ kind: "image", asset: "a", fit: "cover", dim: 0, blur: 0 });
const IMAGE_B = scene({ kind: "image", asset: "b", fit: "cover", dim: 0, blur: 0 });

function showing(visible: WallpaperPresentation["visible"]): WallpaperPresentation {
  return { visible, pending: null };
}

test("the first scene shows at once; nothing to fade from", () => {
  const step = stepWallpaperPresentation(EMPTY_WALLPAPER_PRESENTATION, { type: "request", scene: SILK, ready: true });
  expect(step).toEqual({ state: showing(SILK), present: SILK, crossfade: false });
});

test("another kind, module, image or filter crossfades; params, image options and tone redraw in place", () => {
  expect(stepWallpaperPresentation(showing(SILK), { type: "request", scene: BLOOM, ready: true }).crossfade).toBe(true);
  // Params (a slider drag, a palette) redraw in place.
  const aurora = scene({ kind: "live", module: "butler.bloom", params: { colors: "aurora" } });
  expect(stepWallpaperPresentation(showing(BLOOM), { type: "request", scene: aurora, ready: true })).toEqual({
    state: showing(aurora), present: aurora, crossfade: false,
  });
  const auroraDark = scene({ kind: "live", module: "butler.bloom", params: { colors: "aurora" } }, "dark");
  expect(stepWallpaperPresentation(showing(aurora), { type: "request", scene: auroraDark, ready: true })).toEqual({
    state: showing(auroraDark), present: auroraDark, crossfade: false,
  });
  const dimmed = scene({ kind: "image", asset: "a", fit: "contain", dim: 0.4, blur: 0.2 });
  expect(stepWallpaperPresentation(showing(IMAGE_A), { type: "request", scene: dimmed, ready: true }).crossfade).toBe(false);
  expect(stepWallpaperPresentation(showing(IMAGE_A), { type: "request", scene: IMAGE_B, ready: true }).crossfade).toBe(true);
  const grain = scene({ kind: "image", asset: "a", fit: "cover", dim: 0, blur: 0, filter: { module: "butler.grain" } });
  expect(stepWallpaperPresentation(showing(IMAGE_A), { type: "request", scene: grain, ready: true }).crossfade).toBe(true);
  const grainer = scene({ kind: "image", asset: "a", fit: "cover", dim: 0, blur: 0, filter: { module: "butler.grain", params: { amount: 1 } } });
  expect(stepWallpaperPresentation(showing(grain), { type: "request", scene: grainer, ready: true }).crossfade).toBe(false);
  // An equal source (a new object) is no change.
  const again = scene({ kind: "live", module: "butler.silk" });
  expect(stepWallpaperPresentation(showing(SILK), { type: "request", scene: again, ready: true }).crossfade).toBe(false);
});

test("an image that is not ready keeps the previous wallpaper until it loads, then crossfades", () => {
  const waiting = stepWallpaperPresentation(showing(SILK), { type: "request", scene: IMAGE_A, ready: false });
  expect(waiting).toEqual({ state: { visible: SILK, pending: IMAGE_A }, crossfade: false, load: "a" });
  const loaded = stepWallpaperPresentation(waiting.state, { type: "loaded", asset: "a" });
  expect(loaded).toEqual({ state: showing(IMAGE_A), present: IMAGE_A, crossfade: true });
});

test("with nothing on screen, a loading image draws its neutral field first", () => {
  const waiting = stepWallpaperPresentation(EMPTY_WALLPAPER_PRESENTATION, { type: "request", scene: IMAGE_A, ready: false });
  expect(waiting).toEqual({ state: { visible: IMAGE_A, pending: IMAGE_A }, present: IMAGE_A, crossfade: false, load: "a" });
  // Still only the field on screen: a second image replaces it in place.
  const next = stepWallpaperPresentation(waiting.state, { type: "request", scene: IMAGE_B, ready: false });
  expect(next).toEqual({ state: { visible: IMAGE_B, pending: IMAGE_B }, present: IMAGE_B, crossfade: false, load: "b" });
  expect(stepWallpaperPresentation(next.state, { type: "loaded", asset: "b" })).toEqual({
    state: showing(IMAGE_B), present: IMAGE_B, crossfade: true,
  });
});

test("a newer request supersedes a pending image; its late load is ignored", () => {
  let state = stepWallpaperPresentation(showing(SILK), { type: "request", scene: IMAGE_A, ready: false }).state;
  state = stepWallpaperPresentation(state, { type: "request", scene: IMAGE_B, ready: false }).state;
  expect(state).toEqual({ visible: SILK, pending: IMAGE_B });
  expect(stepWallpaperPresentation(state, { type: "loaded", asset: "a" })).toEqual({ state, crossfade: false });
  const live = stepWallpaperPresentation(state, { type: "request", scene: BLOOM, ready: true });
  expect(live.state).toEqual(showing(BLOOM));
  expect(stepWallpaperPresentation(live.state, { type: "loaded", asset: "b" })).toEqual({ state: live.state, crossfade: false });
  expect(stepWallpaperPresentation(live.state, { type: "failed", asset: "b", message: "late" })).toEqual({ state: live.state, crossfade: false });
});

test("a failed load crossfades to the default module for the tone and reports it", () => {
  const dark = scene({ kind: "image", asset: "a", fit: "cover", dim: 0, blur: 0 }, "dark");
  const waiting = stepWallpaperPresentation(showing(SILK), { type: "request", scene: dark, ready: false }).state;
  const failed = stepWallpaperPresentation(waiting, { type: "failed", asset: "a", message: "404" });
  expect(failed.present?.module).toBe(BLOOM_WALLPAPER);
  expect(failed.present?.dark).toBe(true);
  expect(failed.present?.image).toBeNull();
  expect(failed.state).toEqual(showing(failed.present!));
  expect(failed.crossfade).toBe(true);
  expect(failed.error).toEqual({ reason: "image-load", module: "butler.image", asset: "a", message: "404" });
});

test("the visible image reloading (context restored, sharper variant) redraws without a crossfade", () => {
  expect(stepWallpaperPresentation(showing(IMAGE_A), { type: "loaded", asset: "a" })).toEqual({
    state: showing(IMAGE_A), present: IMAGE_A, crossfade: false,
  });
});

test("none fades the wallpaper out and clears a pending image; the next scene fades in", () => {
  const state = { visible: SILK, pending: IMAGE_A };
  expect(SILK.module).toBe(SILK_WALLPAPER);
  const cleared = stepWallpaperPresentation(state, { type: "request", scene: null, ready: true });
  expect(cleared).toEqual({ state: { visible: null, pending: null, cleared: true }, present: null, crossfade: true });
  expect(stepWallpaperPresentation(cleared.state, { type: "request", scene: BLOOM, ready: true })).toEqual({
    state: showing(BLOOM), present: BLOOM, crossfade: false, fadeIn: true,
  });
  // Nothing was ever shown: none stays a plain empty state.
  expect(stepWallpaperPresentation(EMPTY_WALLPAPER_PRESENTATION, { type: "request", scene: null, ready: true })).toEqual({
    state: EMPTY_WALLPAPER_PRESENTATION, present: null, crossfade: false,
  });
});

test("after none, an image waits for its load (nothing on screen), then fades in", () => {
  const cleared = stepWallpaperPresentation(showing(SILK), { type: "request", scene: null, ready: true }).state;
  const waiting = stepWallpaperPresentation(cleared, { type: "request", scene: IMAGE_A, ready: false });
  expect(waiting).toEqual({ state: { visible: null, pending: IMAGE_A, cleared: true }, crossfade: false, load: "a" });
  expect(stepWallpaperPresentation(waiting.state, { type: "loaded", asset: "a" })).toEqual({
    state: showing(IMAGE_A), present: IMAGE_A, crossfade: false, fadeIn: true,
  });
  const failed = stepWallpaperPresentation(waiting.state, { type: "failed", asset: "a", message: "404" });
  expect(failed.present?.module).toBe(BLOOM_WALLPAPER);
  expect(failed).toMatchObject({ crossfade: false, fadeIn: true });
});

test("a new shader for the shown module (a hot reload) crossfades; the same shader redraws in place", () => {
  const flow = (fragment: string) => defineWallpaperModule({
    manifest: { id: "me.flow", name: { en: "Flow", ko: "흐름" }, version: "0.1.0", engine: 1, motion: "animated", image: "none", params: [] },
    fragment,
  });
  const sceneWith = (module: ReturnType<typeof flow>) =>
    resolveWallpaperScene({ kind: "live", module: "me.flow" }, createWallpaperRegistry([module]), "light")!;
  const before = sceneWith(flow("void main(){fragColor=vec4(1.);}"));
  const edited = sceneWith(flow("void main(){fragColor=vec4(.5);}"));
  expect(stepWallpaperPresentation(showing(before), { type: "request", scene: edited, ready: true }).crossfade).toBe(true);
  const same = sceneWith(flow("void main(){fragColor=vec4(1.);}"));
  expect(stepWallpaperPresentation(showing(before), { type: "request", scene: same, ready: true }).crossfade).toBe(false);
});
