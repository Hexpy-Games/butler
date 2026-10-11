import { useEffect, useState } from "react";

/** Mount the scene only after bundled fonts and the native window can be shown. */
export function useSetupSceneReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const bridge = window.butlerApp as (typeof window.butlerApp & { setupWindowReady?: () => Promise<void> });
    const fonts = document.fonts.load(`16px ${getComputedStyle(document.body).fontFamily}`, "버틀러 Butler")
      .then(() => document.fonts.ready);
    void Promise.all([fonts, bridge?.setupWindowReady?.()]).then(() => {
      if (!cancelled) setReady(true);
    });
    return () => { cancelled = true; };
  }, []);
  return ready;
}
