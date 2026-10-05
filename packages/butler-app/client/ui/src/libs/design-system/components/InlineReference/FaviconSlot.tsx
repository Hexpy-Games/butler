import { useEffect, useState } from "react";
import { Globe2 } from "../Icons";
import styles from "./InlineReference.module.css";

/** A favicon that has not loaded by then is dropped; the globe stays. */
export const FAVICON_TIMEOUT_MS = 4000;

// Per-session memory: a favicon seen once renders loaded at once (no fade on
// re-render or virtualization), and a failed one is never requested again.
const loadedSources = new Set<string>();
const failedSources = new Set<string>();

type FaviconStatus = "fallback" | "loading" | "loaded";

/**
 * Fixed rounded slot: the globe shows at once and the favicon fades in over
 * it once decoded. Every state has the same box, so the text never moves.
 */
export function FaviconSlot({ src }: { src?: string }) {
  const [settled, setSettled] = useState<{ src: string; ok: boolean } | null>(null);
  const status: FaviconStatus = !src || failedSources.has(src) ? "fallback"
    : loadedSources.has(src) ? "loaded"
      : settled?.src === src ? (settled.ok ? "loaded" : "fallback") : "loading";

  useEffect(() => {
    if (status !== "loading" || !src) return undefined;
    const timer = window.setTimeout(() => {
      failedSources.add(src);
      setSettled({ src, ok: false });
    }, FAVICON_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [src, status]);

  const settle = (ok: boolean) => {
    if (!src || failedSources.has(src)) return;
    (ok ? loadedSources : failedSources).add(src);
    setSettled({ src, ok });
  };

  return (
    <span className={styles.slot} data-favicon={status} data-slot="inline-reference-icon" aria-hidden="true">
      <span className={styles.globe}><Globe2 /></span>
      {src && status !== "fallback" ? (
        <img
          className={styles.favicon}
          src={src}
          alt=""
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onLoad={(event) => settle(event.currentTarget.naturalWidth > 0)}
          onError={() => settle(false)}
        />
      ) : null}
    </span>
  );
}
