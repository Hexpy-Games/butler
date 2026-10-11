import { useEffect, useRef, useState } from "react";
import { browserCall, connectBrowser, type BrowserTab } from "./browserBridge";

/** Keep the still painted before detaching the native page for an App overlay. */
export function useBrowserPage(tab?: BrowserTab) {
  const generation = useRef(0);
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
      if (typeof src === "string") setStill({ id: tab.id, src });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }
    if (revision === generation.current) await browserCall("covered", { id: tab.id, value });
  };
  return { stillSrc: still?.id === tab?.id ? still?.src : undefined, covered };
}
