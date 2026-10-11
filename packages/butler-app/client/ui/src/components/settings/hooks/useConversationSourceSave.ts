import { useEffect, useRef } from "react";
import { useButlerStore } from "@/app/store.ts";
import { type WallpaperSource } from "@/butler-ds";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";

function tileKey(source: WallpaperSource) {
  return source.kind === "live" ? source.module : source.kind === "image" ? source.asset : "none";
}

/** Tile choices save once immediately; the tile's own option edits coalesce like Home screen. */
export function useConversationSourceSave() {
  const timer = useRef(0);
  const pending = useRef<WallpaperSource | null>(null);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  const flush = useRef(() => {});
  flush.current = () => {
    window.clearTimeout(timer.current);
    const source = pending.current;
    pending.current = null;
    if (source) void update({ conversation_background: { source } }, setSettings);
  };
  useEffect(() => () => flush.current(), []);
  return (source: WallpaperSource) => {
    const { draft, setDraft } = useSettingsUIStore.getState();
    if (!draft) return;
    const tileChanged = tileKey(source) !== tileKey(draft.conversation_background.source);
    setDraft({ ...draft, conversation_background: { ...draft.conversation_background, source } });
    window.clearTimeout(timer.current);
    pending.current = source;
    if (tileChanged) flush.current();
    else timer.current = window.setTimeout(() => flush.current(), 300);
  };
}
