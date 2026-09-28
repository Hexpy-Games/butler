// What the wallpaper shows while sources change and images load: a pure state machine.
import { fallbackWallpaperScene, type WallpaperScene } from "./registry";
import type { WallpaperError } from "./types";

export interface WallpaperPresentation {
  /** On screen. An image scene whose image is missing draws the neutral field. */
  visible: WallpaperScene | null;
  /**
   * An image scene waiting for its image while `visible` stays on screen.
   * When nothing else was on screen, the waiting scene is also `visible`
   * (its neutral field holds the place).
   */
  pending: WallpaperScene | null;
  /** `none` cleared a shown wallpaper: the next scene fades in (an image waits for its load first). */
  cleared?: true;
}

export const EMPTY_WALLPAPER_PRESENTATION: WallpaperPresentation = { visible: null, pending: null };
const CLEARED: WallpaperPresentation = { visible: null, pending: null, cleared: true };

export type WallpaperPresentationEvent =
  /** `ready`: the scene has no image, or its image is already uploaded. */
  | { type: "request"; scene: WallpaperScene | null; ready: boolean }
  | { type: "loaded"; asset: string }
  | { type: "failed"; asset: string; message: string };

export interface WallpaperPresentationStep {
  state: WallpaperPresentation;
  /** Hand this scene to the renderer (null: clear the canvas); absent: keep drawing the current one. */
  present?: WallpaperScene | null;
  /** Fade the previous frame out over the presented scene (or over nothing, for `none`). */
  crossfade: boolean;
  /** Nothing was on screen after `none`: fade the presented scene in. */
  fadeIn?: true;
  /** Start loading this asset's image. */
  load?: string;
  error?: WallpaperError;
}

/** Shows `scene`: a crossfade from what is on screen, or a fade-in from nothing after `none`. */
function show(state: WallpaperPresentation, scene: WallpaperScene, extra: Partial<WallpaperPresentationStep> = {}): WallpaperPresentationStep {
  const { visible } = state;
  const next = { state: { visible: scene, pending: null }, present: scene, ...extra };
  if (!visible) return state.cleared ? { ...next, crossfade: false, fadeIn: true } : { ...next, crossfade: false };
  // Same module and image (only params, image options or the tone changed): redraw in place.
  // A new shader for the same module (a user module's hot reload) crossfades like another module.
  return { ...next, crossfade: visible.key !== scene.key || visible.module.fragment !== scene.module.fragment };
}

function request(state: WallpaperPresentation, scene: WallpaperScene | null, ready: boolean): WallpaperPresentationStep {
  const { visible, pending, cleared } = state;
  if (!scene) {
    const shown = visible !== null || cleared === true;
    return { state: shown ? CLEARED : EMPTY_WALLPAPER_PRESENTATION, present: null, crossfade: visible !== null };
  }
  if (ready || !scene.image) return show(state, scene);
  const asset = scene.image.asset;
  // Cleared by none: keep the screen empty until the image can fade in.
  if (!visible && cleared) return { state: { ...CLEARED, pending: scene }, crossfade: false, load: asset };
  // Only a neutral field on screen: hold the place with the new scene's field.
  if (!visible || visible === pending) return { state: { visible: scene, pending: scene }, present: scene, crossfade: false, load: asset };
  return { state: { visible, pending: scene }, crossfade: false, load: asset };
}

/**
 * Transition policy: another kind, module (or a module's new shader), image
 * or filter module crossfades (the previous frame fades out over the next);
 * params, fit/dim/blur, the tone or an equal source redraw in place (no
 * flicker while dragging a slider);
 * `none` fades the last frame out, and the next scene fades in. Images: the
 * previous wallpaper stays until the new image is uploaded, then crossfades
 * to it; a failed load crossfades to the default module and reports
 * `image-load`. Late results for superseded images are ignored; the visible
 * image reloading (restored context, sharper variant) redraws in place.
 */
export function stepWallpaperPresentation(state: WallpaperPresentation, event: WallpaperPresentationEvent): WallpaperPresentationStep {
  if (event.type === "request") return request(state, event.scene, event.ready);
  const { visible, pending } = state;
  const scene = [pending, visible].find((candidate) => candidate?.image?.asset === event.asset);
  if (!scene) return { state, crossfade: false };
  if (event.type === "loaded") {
    if (scene !== pending) return { state, present: scene, crossfade: false };
    // From its own neutral field, or from the previous wallpaper: always a crossfade.
    const step = show(visible === pending ? { visible: null, pending: null } : state, scene);
    return visible ? { ...step, crossfade: true } : step;
  }
  const fallback = fallbackWallpaperScene(scene.dark);
  const error: WallpaperError = { reason: "image-load", module: scene.module.manifest.id, asset: event.asset, message: event.message };
  const step = show(state, fallback, { error });
  return { ...step, state: { visible: fallback, pending: scene === pending ? null : pending } };
}
