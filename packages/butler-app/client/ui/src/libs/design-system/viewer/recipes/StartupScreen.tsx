import { useEffect, useRef, useState } from "react";
import { useWallpaperTone } from "../../blocks/Wallpaper/wallpaperTone";
import { prefersReducedMotion, subscribeReducedMotion } from "../../lib/motion";
import { lifecycleCopy } from "../../../../../../../../butler-i18n/src/lifecycle";
import styles from "./StartupScreen.module.css";

/** Preview the exact shipped static document, including its first-frame poster. */
export function StartupScreen({ stage, wallpaper, locale, onRetry, onLogs }: {
  stage: string; wallpaper: string; locale: "ko" | "en";
  onRetry: () => void; onLogs: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const scope = useRef<HTMLDivElement>(null);
  const tone = useWallpaperTone(scope);
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => subscribeReducedMotion(setReduced), []);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== location.origin) return;
      if (event.data?.startupAction === "retry") onRetry();
      if (event.data?.startupAction === "logs") onLogs();
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [onRetry, onLogs]);
  const id = wallpaper === "none" ? "butler.bloom" : wallpaper;
  const posterTone = ["butler.dusk", "butler.shoreline", "butler.photo-clouds", "butler.photo-daisies"].includes(id) ? "light" : tone;
  const mapped = ({ starting: "prepare", agent: "service", migration: "upgrade", renderer: "screen", failed: "service" } as Record<string, string>)[stage] ?? stage;
  const query = new URLSearchParams({ kind: "startup", stage: mapped, locale, theme: tone,
    motion: reduced ? "reduced" : "auto" });
  if (wallpaper !== "none") query.set("still", `stills/${id}.${posterTone}.0.webp`);
  const loaded = () => {
    const target = frame.current?.contentWindow as (Window & { lifecycleState(value: unknown): void }) | null;
    if (!target) return;
    target.lifecycleState({ kind: "startup", stage: mapped, theme: tone, locale, copy: lifecycleCopy,
      state: stage === "failed" ? "error" : "working", failedStage: mapped, motion: reduced ? "reduced" : "auto" });
    const primary = target.document.querySelector<HTMLButtonElement>('[data-slot="primary"]');
    const secondary = target.document.querySelector<HTMLButtonElement>('[data-slot="secondary"]');
    if (primary) primary.onclick = onRetry;
    if (secondary) secondary.onclick = onLogs;
  };
  return <div ref={scope} className={styles.screen}>
    <iframe ref={frame} title={locale === "ko" ? "시작 화면" : "Startup window"}
      className={styles.frame} onLoad={loaded} src={`./lifecycle/lifecycle.html?${query}`} />
  </div>;
}
