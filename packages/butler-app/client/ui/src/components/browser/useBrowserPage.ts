import { useEffect, useRef, useState } from "react";
import { browserCall, connectBrowser, useBrowserState, type BrowserTab } from "./browserBridge";

/** A background/occluded document may stop rAF; it must still release a held pane transition. */
function presentStill() {
  if (document.hidden) return Promise.resolve();
  return new Promise<void>(resolve => {
    let frame = 0;
    const done = () => {
      clearTimeout(timer); cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", changed); resolve();
    };
    const changed = () => { if (document.hidden) done(); };
    const timer = setTimeout(done, 1000);
    document.addEventListener("visibilitychange", changed);
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(done); });
  });
}

/** Keep the still painted before detaching the native page for an App overlay. */
export function useBrowserPage(tab?: BrowserTab) {
  const generation = useRef(0);
  const layoutRevision = useBrowserState(state => state.layoutRevision);
  // Native window events may resume a slot whose last animation frame was occluded.
  // Feed the existing DS geometry/occlusion tracker, including when its rect is unchanged.
  useEffect(() => { window.dispatchEvent(new Event("resize")); }, [layoutRevision]);
  const [still, setStill] = useState<{ id: string; src: string }>();
  useEffect(() => {
    let current = true;
    if (tab?.status === "idle" && tab.url) {
      void browserCall("still", { id: tab.id }).then((src) => {
        if (current && typeof src === "string") setStill({ id: tab.id, src });
      });
    }
    return () => { current = false; };
  }, [tab?.id, tab?.status, tab?.url]);
  useEffect(() => {
    connectBrowser();
    void browserCall("open");
    return () => { generation.current += 1; void browserCall("hide"); };
  }, []);
  const covered = async (value: boolean) => {
    const revision = ++generation.current;
    if (!tab) return;
    if (value) {
      const src = await browserCall("still", { id: tab.id });
      if (revision !== generation.current) return;
      // Decoded first, so the still paints in the frame it mounts in, before the page leaves.
      if (typeof src === "string") {
        const decoded = new Image();
        decoded.src = src;
        await decoded.decode().catch(() => undefined);
        if (revision !== generation.current) return;
        setStill({ id: tab.id, src });
      }
      await presentStill();
    }
    if (revision === generation.current) await browserCall("covered", { id: tab.id, value });
  };
  return { stillSrc: still?.id === tab?.id ? still?.src : undefined, covered };
}
