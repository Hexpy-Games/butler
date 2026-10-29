import { useState, type KeyboardEvent } from "react";
import { ImageIcon } from "../../components/Icons";
import { TintedGlass } from "../../components/TintedGlass";
import { Typo } from "../../components/Typo";
import { dsClass } from "../../lib/internal";
import { cn } from "../../lib/utils";
import type { ImageViewerImage } from "./ImageViewerSurface";
import styles from "./ImageViewer.module.css";
import { ZOOM_STEP, type useZoomPan, type ZoomView } from "./zoom";

type Zoom = ReturnType<typeof useZoomPan>;

function zoomTransform({ scale, x, y }: ZoomView) {
  return scale === 1 ? undefined : `translate(${x}px, ${y}px) scale(${scale})`;
}

export function Picture({ image, failedLabel, zoom }: { image: ImageViewerImage; failedLabel: string; zoom: Zoom }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === image.src) {
    return (
      <TintedGlass className={dsClass(styles.failed)} radius="control" padding="md" role="img" aria-label={`${image.alt} · ${failedLabel}`}>
        <ImageIcon size="xl" />
        <Typo.Caption tone="secondary">{failedLabel}</Typo.Caption>
      </TintedGlass>
    );
  }
  if (image.kind === "video") {
    return (
      <video key={image.src} className={cn(styles.picture, styles.video)} src={image.src} aria-label={image.alt}
        controls playsInline preload="metadata" onError={() => setFailed(image.src)} />
    );
  }
  return (
    <img key={image.src} ref={(node) => { zoom.targetRef.current = node; }} className={styles.picture} src={image.src} alt={image.alt}
      draggable={false} data-zoomed={zoom.view.scale > 1 ? "" : undefined} style={{ transform: zoomTransform(zoom.view) }}
      onError={() => setFailed(image.src)} {...zoom.handlers} />
  );
}

/** +/= zooms in, - out, 0 back to fit. */
export function zoomKeys(zoom: Zoom) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.target instanceof HTMLMediaElement) return;
    const action = event.key === "+" || event.key === "=" ? () => zoom.zoomBy(ZOOM_STEP)
      : event.key === "-" ? () => zoom.zoomBy(1 / ZOOM_STEP)
        : event.key === "0" ? zoom.reset : undefined;
    if (!action) return;
    event.preventDefault();
    action();
  };
}
