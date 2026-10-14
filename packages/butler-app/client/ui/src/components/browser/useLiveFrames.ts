import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Ephemeral decoded frames; never enter a persisted store or a message file.
 * `paused` stops the streams but keeps the last frames of `ids`; frames of
 * tabs no longer in `ids` are dropped and their bitmaps closed.
 */
export function useLiveFrames(ids: readonly string[], width = 416, paused = false) {
  const key = JSON.stringify([...ids].sort());
  const [frames, setFrames] = useState<Record<string, ImageBitmap>>({});
  const owned = useRef(new Set<ImageBitmap>());
  useLayoutEffect(() => {
    const shown = new Set(Object.values(frames));
    for (const bitmap of owned.current) {
      if (!shown.has(bitmap)) { bitmap.close(); owned.current.delete(bitmap); }
    }
  }, [frames]);
  useEffect(() => {
    const wanted = new Set(JSON.parse(key) as string[]);
    setFrames(current => Object.keys(current).every(id => wanted.has(id)) ? current
      : Object.fromEntries(Object.entries(current).filter(([id]) => wanted.has(id))));
  }, [key]);
  useEffect(() => {
    if (paused) return undefined;
    let active = true;
    const revisions = new Map<string, number>();
    const stops = (JSON.parse(key) as string[]).map(id => window.butlerBrowser?.onFrame?.(id, async frame => {
      revisions.set(id, frame.seq);
      try {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(frame.bytes)], { type: "image/jpeg" }));
        if (!active || revisions.get(id) !== frame.seq) { bitmap.close(); return; }
        owned.current.add(bitmap);
        setFrames(current => ({ ...current, [id]: bitmap }));
      } catch { /* Keep the last complete frame if decoding fails. */ }
    }, width));
    return () => { active = false; for (const stop of stops) stop?.(); };
  }, [key, width, paused]);
  useEffect(() => () => { for (const bitmap of owned.current) bitmap.close(); owned.current.clear(); }, []);
  return frames;
}

export function useDocumentVisible() {
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}
