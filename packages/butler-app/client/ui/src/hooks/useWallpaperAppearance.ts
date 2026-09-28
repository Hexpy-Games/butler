import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { useButlerStore } from "@/app/store.ts";
import { resolveAppearanceTheme } from "@/app/utils.ts";
import { crossfadeDocumentChange, useWallpaperSceneTone } from "@/butler-ds";
import { placeWallpaper } from "@/components/conversation/mainScreenTheme.ts";
import { effectiveAppearanceTheme, useAppearanceOverrideStore } from "@/stores/appearanceStore.ts";

/**
 * Lets a real-time wallpaper set the app appearance (its manifest `sceneTone`,
 * e.g. dark after sunset): the wallpaper of the place on screen decides, and a
 * flip cross-fades the window. The setting takes over again when it stops.
 */
export function useWallpaperAppearance(): void {
  const settings = useButlerStore((state) => state.settings);
  const navigation = useButlerStore((state) => state.navigation);
  const view = useButlerStore((state) => state.view);
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const tone = useWallpaperSceneTone(placeWallpaper(settings, navigation, view, activeChatId).source);
  const setting = settings.appearance_theme;
  const first = useRef(true);
  // The tone to show once a cross-fade runs, and whether one is queued: the
  // fade applies the latest tone, never the one it was queued for.
  const latest = useRef(tone);
  const pending = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    latest.current = tone;
    const { sceneTone, setSceneTone } = useAppearanceOverrideStore.getState();
    const initial = first.current;
    first.current = false;
    // A queued fade will apply this tone.
    if (pending.current || sceneTone === tone) return;
    const before = resolveAppearanceTheme(effectiveAppearanceTheme(setting, sceneTone));
    const after = resolveAppearanceTheme(effectiveAppearanceTheme(setting, tone));
    if (initial || before === after) {
      setSceneTone(tone);
      return;
    }
    pending.current = true;
    const apply = () => {
      pending.current = false;
      // Unmounted meanwhile: the cleanup's reset wins.
      if (!mounted.current) return;
      flushSync(() => useAppearanceOverrideStore.getState().setSceneTone(latest.current));
    };
    // After this commit, outside React's lifecycle: the fade captures the old look, then the new one renders at once.
    queueMicrotask(() => {
      if (mounted.current) crossfadeDocumentChange(apply);
      else pending.current = false;
    });
  }, [setting, tone]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      useAppearanceOverrideStore.getState().setSceneTone(null);
    };
  }, []);
}
