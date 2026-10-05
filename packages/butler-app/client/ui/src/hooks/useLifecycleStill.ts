import { useEffect, useRef } from "react";
import { useButlerStore } from "@/app/store";
import { loadWallpaperAssetImage } from "@/app/wallpaperAssets";
import { userWallpaperModules } from "@/app/userWallpaperModules";
import { renderWallpaperStill, wallpaperSourceKey, type WallpaperSource } from "@/butler-ds";
import { encodeLifecycleStill } from "@/components/lifecycle/still";
import { useAppearanceTheme } from "@/stores/appearanceStore";

/** Change-driven still cache for the next launch; no work on the typing path. */
export function useLifecycleStill() {
  const source = useButlerStore((state) => state.settings.wallpaper?.source);
  const appearance = useAppearanceTheme();
  const last = useRef("");
  const key = source ? wallpaperSourceKey(source) : "";
  useEffect(() => {
    const bridge = window.butlerApp as typeof window.butlerApp & { saveLifecycleStill?: (input: unknown) => Promise<boolean> };
    if (!bridge?.saveLifecycleStill || !source || source.kind === "none") return;
    const parsed = JSON.parse(key) as Exclude<WallpaperSource, { kind: "none" }>;
    const id = parsed.kind === "live" ? parsed.module : parsed.filter?.module;
    const registry = userWallpaperModules.getSnapshot().registry;
    const dayPhase = id === "butler.shoreline";
    const shared = ["butler.dusk", "butler.shoreline", "butler.photo-clouds", "butler.photo-daisies"].includes(id ?? "");
    let cancelled = false;
    const update = async () => {
      const now = new Date();
      const phase = Math.floor((now.getHours() * 60 + now.getMinutes()) / 15);
      const sourceKey = key + (dayPhase ? `|${phase}` : "");
      const requestKey = `${sourceKey}|${appearance}`;
      if (last.current === requestKey) return;
      for (const tone of shared ? ["light"] as const : ["light", "dark"] as const) {
        const blob = await renderWallpaperStill(parsed, { width: 720, height: 528, compositionWidth: 720, pixelRatio: 2,
          contentRect: { x: 32, y: 60, width: 296, height: 144 }, dayPhase: phase / 96, imageLoader: loadWallpaperAssetImage }, tone, registry);
        const encoded = await encodeLifecycleStill(blob);
        if (cancelled) return;
        if (!await bridge.saveLifecycleStill!({ sourceKey, tone, ...encoded })) throw new Error("lifecycle_still_rejected");
      }
      last.current = requestKey;
    };
    const refresh = () => { void update().catch(() => { /* Startup uses the bundled fallback when a still is unavailable. */ }); };
    refresh();
    let timer: number | undefined;
    const schedule = () => {
      const delay = 15 * 60 * 1000 - Date.now() % (15 * 60 * 1000);
      timer = window.setTimeout(() => { refresh(); if (!cancelled) schedule(); }, delay);
    };
    if (dayPhase) schedule();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [key, appearance]);
}
