import { useEffect, useRef, useState } from "react";
import { useWallpaperTone } from "../../blocks/Wallpaper/wallpaperTone";
import { prefersReducedMotion, subscribeReducedMotion } from "../../lib/motion";
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
  const query = new URLSearchParams({ preview: "true", stage, language: locale,
    motion: reduced ? "reduced" : "auto", poster: `startup/posters/${id}.${posterTone}.png` });
  return <div ref={scope} className={styles.screen}>
    <iframe ref={frame} title={locale === "ko" ? "시작 화면" : "Startup window"}
      className={styles.frame} src={`./startup.html?${query}`} />
  </div>;
}
