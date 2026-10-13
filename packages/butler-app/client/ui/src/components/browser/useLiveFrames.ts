import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Ephemeral decoded frames; never enter a persisted store or a message file. */
export function useLiveFrames(ids: readonly string[], width = 416) {
  const key = JSON.stringify(ids);
  const [frames, setFrames] = useState<Record<string, ImageBitmap>>({});
  const owned = useRef(new Set<ImageBitmap>());
  useLayoutEffect(() => {
    for (const bitmap of owned.current) {
      if (!Object.values(frames).includes(bitmap)) { bitmap.close(); owned.current.delete(bitmap); }
    }
  }, [frames]);
  useEffect(() => {
    let active = true;
    const revisions = new Map<string, number>();
    if ((JSON.parse(key) as string[]).length) setFrames(current => Object.fromEntries(Object.entries(current).filter(([id]) => (JSON.parse(key) as string[]).includes(id))));
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
  }, [key, width]);
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
