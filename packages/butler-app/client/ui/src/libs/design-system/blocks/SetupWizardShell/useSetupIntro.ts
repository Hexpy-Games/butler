import { useEffect, useState } from "react";
import { createWallpaperIntroTimeline, type WallpaperIntroTimeline } from "../Wallpaper/intro/introTimeline";
import type { SetupWizardIntro } from "./SetupWizardStage";

function introTimeline(intro: SetupWizardIntro | undefined): WallpaperIntroTimeline | null {
  return intro === "full" || intro === "rerun" ? createWallpaperIntroTimeline(intro === "full" ? "full" : "still") : null;
}

/**
 * The ink intro clock of a setup shell, chosen once at mount (or when the hold ends): the full reveal for intro full,
 * the dried still for rerun, none otherwise. wash: the reveal started without WebGL2, so a still ink wash stands in for
 * the print.
 */
export function useSetupIntro(intro: SetupWizardIntro | undefined, held = false): { timeline: WallpaperIntroTimeline | null; wash: boolean } {
  // undefined: held, nothing chosen yet.
  const [chosen, setChosen] = useState<WallpaperIntroTimeline | null | undefined>(() => (held ? undefined : introTimeline(intro)));
  if (chosen === undefined && !held) setChosen(introTimeline(intro));
  const timeline = chosen ?? null;
  const [wash, setWash] = useState(timeline?.started() === "fallback");
  useEffect(() => {
    if (!timeline) return undefined;
    const unsubscribe = timeline.subscribe((event) => {
      if (event.type === "start" && event.kind === "fallback") setWash(true);
    });
    // The backdrop mounts first and may have started the fallback already.
    if (timeline.started() === "fallback") setWash(true);
    return unsubscribe;
  }, [timeline]);
  return { timeline, wash };
}
