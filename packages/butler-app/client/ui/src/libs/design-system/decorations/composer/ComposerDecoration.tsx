import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { mountComposerDecoration } from "./runtime";
import type { DecorationMetrics, DecorationOptions, DecorationTheme } from "./types";
import styles from "./ComposerDecoration.module.css";

export interface ComposerDecorationProps extends Omit<DecorationOptions, "theme"> {
  theme: DecorationTheme;
  /** Existing ComposerCard container, only for characters seated across its edge. */
  edgeHost: HTMLDivElement | null;
  onMetrics: (metrics: DecorationMetrics) => void;
}

function Layer({ theme, mode, intensity, tone, inside, edgeHost, onMetrics }: ComposerDecorationProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const report = useRef(onMetrics);
  report.current = onMetrics;
  const outside = theme === "characters" && !inside;
  useEffect(() => {
    const target = canvas.current;
    const form = edgeHost?.querySelector("form");
    if (!target || !form || theme === "none") return;
    return mountComposerDecoration(target, form, { theme, mode, intensity, tone, inside }, (metrics) => report.current(metrics));
  }, [theme, mode, intensity, tone, inside, edgeHost]);
  const layer = (
    <div aria-hidden="true" className={outside ? styles.edge : styles.background} data-composer-decoration={theme}>
      <canvas className={styles.canvas} ref={canvas} data-frames="0" />
      {outside ? null : <div className={styles.veil} />}
    </div>
  );
  return outside ? edgeHost && createPortal(layer, edgeHost) : layer;
}

/** First child of the unchanged ComposerCard. It owns no input, toolbar or surface. */
export function ComposerDecoration(props: ComposerDecorationProps) {
  if (props.theme === "none") return null;
  // A disposed WebGL canvas cannot host a new renderer; option changes get a fresh canvas.
  return <Layer key={`${props.theme}/${props.mode}/${props.tone}/${props.inside}/${props.intensity}`} {...props} />;
}
