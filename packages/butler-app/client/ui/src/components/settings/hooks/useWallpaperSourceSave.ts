import { useEffect, useRef } from "react";
import { useButlerStore } from "@/app/store.ts";
import type { WallpaperSource } from "@/butler-ds";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";

/** Trailing wait before a wallpaper edit is written: a slider drag saves once. */
const SAVE_DELAY = 300;

/**
 * Saves the Home screen wallpaper source: the settings draft updates at once
 * (the picker follows every step), and the PATCH goes out once edits pause
 * (or when the screen closes).
 */
export function useWallpaperSourceSave(): (source: WallpaperSource) => void {
  const setDraft = useSettingsUIStore((state) => state.setDraft);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  const pending = useRef<WallpaperSource | null>(null);
  const timer = useRef(0);
  const flush = useRef<() => void>(() => undefined);

  useEffect(() => {
    flush.current = () => {
      window.clearTimeout(timer.current);
      const source = pending.current;
      pending.current = null;
      if (source) void update({ wallpaper: { source } }, setSettings);
    };
  });

  useEffect(() => () => flush.current(), []);

  return (source) => {
    const draft = useSettingsUIStore.getState().draft;
    if (!draft) return;
    setDraft({ ...draft, wallpaper: { ...draft.wallpaper, source } });
    pending.current = source;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => flush.current(), SAVE_DELAY);
  };
}
