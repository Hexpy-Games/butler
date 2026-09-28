import { createWallpaperCrossfade } from "./crossfade";
import type { WallpaperEngineOptions } from "./engineTypes";
import { createWallpaperImageCache, decodeWallpaperImage } from "./imageCache";
import { wallpaperImageVariant } from "./imageMath";
import {
  EMPTY_WALLPAPER_PRESENTATION,
  stepWallpaperPresentation,
  type WallpaperPresentationEvent,
} from "./presentation";
import type { WallpaperScene } from "./registry";
import type { WallpaperRenderer } from "./renderer";
import type { WallpaperImageLoader, WallpaperModuleMotion, WallpaperPixelRatioMode } from "./types";

export interface WallpaperPresenterOptions extends WallpaperEngineOptions {
  canvas: HTMLCanvasElement;
  renderer: WallpaperRenderer;
  /** A frame is on the canvas (something to fade from). */
  hasDrawn: () => boolean;
  /** Hands a scene to the renderer and schedules a frame; null draws nothing. */
  show: (scene: WallpaperScene | null) => void;
  /** Draws the current scene again now (the crossfade snapshots it). */
  repaint: () => void;
  /** The drawing-buffer size of the canvas under a module's render policy. */
  bufferSize: (motion: WallpaperModuleMotion, pixelRatio: WallpaperPixelRatioMode) => { width: number; height: number };
}

export interface WallpaperPresenter {
  request(scene: WallpaperScene | null): void;
  /** After a resize or a restored context: loads the visible image again when it is missing or smaller than the canvas needs. */
  refresh(): void;
  /** A frame is on the canvas (reveals the first scene after `none`). */
  drawn(): void;
  dispose(): void;
}

const NO_LOADER: WallpaperImageLoader = () => Promise.reject(new Error("No imageLoader for image wallpapers"));

/**
 * Loads images for scenes and decides what the renderer shows meanwhile and
 * how it transitions (`stepWallpaperPresentation`: crossfade, fade-in, or in
 * place): bytes cached by asset, decoded bitmaps uploaded then closed,
 * textures released once no scene uses them.
 */
export function createWallpaperPresenter(options: WallpaperPresenterOptions): WallpaperPresenter {
  const { canvas, renderer, hasDrawn, show, repaint, bufferSize, onError, decode = decodeWallpaperImage } = options;
  const cache = createWallpaperImageCache(options.imageLoader ?? NO_LOADER);
  const crossfade = createWallpaperCrossfade(canvas, options.overlay ?? null, repaint);
  const inflight = new Set<string>();
  let state = EMPTY_WALLPAPER_PRESENTATION;
  let disposed = false;

  const images = () => {
    const assets = [state.visible?.image?.asset, state.pending?.image?.asset];
    return new Set(assets.filter((asset): asset is string => asset !== undefined));
  };

  // The buffer the asset's scene draws at, under its module's policy; a thumbnail serves buffers it covers.
  const variant = (asset: string) => {
    const manifest = [state.pending, state.visible].find((scene) => scene?.image?.asset === asset)?.module.manifest;
    return wallpaperImageVariant(bufferSize(manifest?.motion ?? "static", manifest?.pixelRatio ?? "default"));
  };

  const dispatch = (event: WallpaperPresentationEvent) => {
    const step = stepWallpaperPresentation(state, event);
    state = step.state;
    if (step.error) onError(step.error);
    if (step.present !== undefined) {
      if (step.crossfade && hasDrawn()) crossfade.start();
      if (step.present) crossfade.show(step.fadeIn === true);
      else crossfade.clear();
      show(step.present);
    }
    const used = images();
    renderer.retainImages(used);
    cache.retain(used);
    if (step.load) load(step.load);
  };

  function load(asset: string) {
    const wanted = variant(asset);
    const key = `${wanted}\n${asset}`;
    if (inflight.has(key)) return;
    inflight.add(key);
    cache.blob(asset, wanted).then(decode).then((bitmap) => {
      inflight.delete(key);
      // A late thumbnail never replaces the full image.
      const downgrade = wanted === "thumbnail" && renderer.imageVariant(asset) === "full";
      if (!disposed && !downgrade && images().has(asset)) renderer.setImage(asset, wanted, bitmap);
      bitmap.close();
      if (!disposed) dispatch({ type: "loaded", asset });
    }).catch((error: unknown) => {
      inflight.delete(key);
      if (!disposed) dispatch({ type: "failed", asset, message: error instanceof Error ? error.message : String(error) });
    });
  }

  return {
    request(scene) {
      const asset = scene?.image?.asset;
      dispatch({ type: "request", scene, ready: asset === undefined || renderer.imageVariant(asset) !== null });
    },
    refresh() {
      for (const asset of images()) {
        const loaded = renderer.imageVariant(asset);
        if (loaded !== "full" && loaded !== variant(asset)) load(asset);
      }
    },
    drawn: () => crossfade.drawn(),
    dispose() {
      disposed = true;
      crossfade.dispose();
    },
  };
}
