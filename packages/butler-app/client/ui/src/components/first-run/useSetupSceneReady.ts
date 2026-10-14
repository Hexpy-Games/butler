import { useEffect, useState } from "react";

/** hold: the intro waits. full: play it. still: the window was shown but never became visible (a locked or covered screen). */
export type SetupScene = "hold" | "full" | "still";

/**
 * The setup card renders at once; its intro waits for bundled fonts and a visible native window. Native answers "still"
 * when a shown window stays occluded, and the card then arrives on the dried print without the reveal.
 */
export function useSetupScene(): SetupScene {
  const [scene, setScene] = useState<SetupScene>("hold");
  useEffect(() => {
    let cancelled = false;
    const bridge = window.butlerApp as (typeof window.butlerApp & { setupWindowReady?: () => Promise<"shown" | "still"> });
    const fonts = document.fonts.load(`16px ${getComputedStyle(document.body).fontFamily}`, "버틀러 Butler")
      .then(() => document.fonts.ready).catch(() => undefined);
    // Outside the App, or in a window native does not track, nothing waits for the window.
    const visible = bridge?.setupWindowReady?.().catch(() => "shown" as const) ?? Promise.resolve("shown" as const);
    void Promise.all([visible, fonts]).then(([shown]) => {
      if (!cancelled) setScene(shown === "still" ? "still" : "full");
    });
    return () => { cancelled = true; };
  }, []);
  return scene;
}
