import { useEffect, useState } from "react";
import type { WallpaperRegistry } from "./registry";
import { useWallpaperRegistry } from "./registryContext";
import { wallpaperDayPhase } from "./time";
import type { WallpaperModule, WallpaperSource, WallpaperTone } from "./types";
import { resolveWallpaperValues, type WallpaperParamInput } from "./values";

/** How often an active scene tone re-reads the clock (it also does when the document shows again). */
export const WALLPAPER_SCENE_TONE_CHECK_MS = 15_000;

/**
 * A module's own tone at `dayPhase` (`manifest.sceneTone`): while its switch
 * param is on — read as the light theme resolves it, so the result never
 * depends on the tone it sets — dark inside a `darkPhases` range, else light.
 * Null when the module has no scene tone or the switch is off.
 */
export function wallpaperModuleSceneTone(module: WallpaperModule | undefined, input: WallpaperParamInput, dayPhase: number): WallpaperTone | null {
  const spec = module?.manifest.sceneTone;
  if (!module || !spec) return null;
  if (resolveWallpaperValues(module.manifest, input, "light")[spec.param] !== true) return null;
  return spec.darkPhases.some(([start, end]) => dayPhase >= start && dayPhase < end) ? "dark" : "light";
}

/** The scene tone of a source (a live module, or an image's filter); null when it has none. */
export function wallpaperSceneTone(source: WallpaperSource | null | undefined, registry: WallpaperRegistry, dayPhase: number): WallpaperTone | null {
  if (source?.kind === "live") return wallpaperModuleSceneTone(registry.get(source.module), source, dayPhase);
  if (source?.kind === "image" && source.filter) return wallpaperModuleSceneTone(registry.get(source.filter.module), source.filter, dayPhase);
  return null;
}

/**
 * The scene tone of `source` now (see `wallpaperSceneTone`), kept current with
 * the local clock — `u_dayPhase` reads the same clock — so an app can let a
 * real-time wallpaper set its appearance. Null when the source sets none.
 */
export function useWallpaperSceneTone(source: WallpaperSource | null | undefined, explicitRegistry?: WallpaperRegistry): WallpaperTone | null {
  const registry = useWallpaperRegistry(explicitRegistry);
  const read = () => wallpaperSceneTone(source, registry, wallpaperDayPhase(new Date()));
  const [tone, setTone] = useState<WallpaperTone | null>(read);
  const key = JSON.stringify(source ?? null);

  useEffect(() => {
    const parsed = JSON.parse(key) as WallpaperSource | null;
    const update = () => setTone(wallpaperSceneTone(parsed, registry, wallpaperDayPhase(new Date())));
    update();
    // Off (no scene tone, or its switch is off) at one phase means off at every phase.
    if (wallpaperSceneTone(parsed, registry, 0) === null) return undefined;
    const timer = window.setInterval(update, WALLPAPER_SCENE_TONE_CHECK_MS);
    const visible = () => {
      if (document.visibilityState === "visible") update();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [key, registry]);

  return tone;
}
