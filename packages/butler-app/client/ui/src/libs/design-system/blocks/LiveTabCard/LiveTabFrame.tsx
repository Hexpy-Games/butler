import { useLayoutEffect, useRef } from "react";
import { MediaFrame } from "../../components/MediaFrame";
import { dsClass } from "../../lib/internal";
import styles from "./LiveTabCard.module.css";

/**
 * A live page frame: a decoded `ImageBitmap` (the owner's screencast frame)
 * or a picture URL (a still). The DS never fetches or decodes frames itself.
 */
export type LiveTabFrameSource = ImageBitmap | string;

export interface LiveTabFrameProps {
  /** The current frame. Omitted or null: the favicon on the matte until the first frame arrives. */
  frame?: LiveTabFrameSource | null;
  /** Favicon URL for the placeholder. */
  favicon?: string;
  /** Grey the page (a crashed or failed tab). */
  dimmed?: boolean;
}

/**
 * Draws one bitmap onto a canvas the bitmap's own size; CSS scales it to the
 * frame, so a resize never redraws. A new bitmap swaps in without a
 * crossfade. The owner may close the previous bitmap once the next one is
 * passed; a closed bitmap keeps the last drawn pixels.
 */
function BitmapCanvas({ bitmap }: { bitmap: ImageBitmap }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas || !bitmap.width || !bitmap.height) return;
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
    if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
    try {
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    } catch {
      // A bitmap closed before it was drawn: keep the previous frame.
    }
  }, [bitmap]);
  return <canvas ref={ref} className={styles.canvas} aria-hidden="true" data-slot="live-tab-canvas" />;
}

/** A 16:10 page frame on the neutral matte, drawn from a passed bitmap or picture URL. */
export function LiveTabFrame({ frame, favicon, dimmed = false }: LiveTabFrameProps) {
  const src = typeof frame === "string" ? frame : undefined;
  const bitmap = frame && typeof frame !== "string" ? frame : null;
  return (
    <MediaFrame className={dsClass(styles.frame)} aspect="16:10" fit="cover" src={src} placeholder={!frame}
      placeholderIcon={favicon} data-dimmed={dimmed ? "true" : undefined}>
      {bitmap ? <BitmapCanvas bitmap={bitmap} /> : null}
    </MediaFrame>
  );
}
