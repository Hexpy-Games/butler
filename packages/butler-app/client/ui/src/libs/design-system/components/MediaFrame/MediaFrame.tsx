import { useCallback, useState, type HTMLAttributes, type ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import styles from "./MediaFrame.module.css";

/** Frame shapes, width:height. */
export type MediaFrameAspect = "1:1" | "4:5" | "3:4" | "16:10" | "16:9";

/** `pending` until the picture's shape is known; `failed` on a load error; `empty` without a picture. */
export type MediaFrameState = "pending" | "fill" | "matte" | "failed" | "empty";

export interface MediaFrameProps extends DsBaseProps<HTMLAttributes<HTMLSpanElement>> {
  /** Picture URL. Omitted: an empty matte of the same shape. */
  src?: string;
  /** Alternative text. Default "" (decorative: the owning title names the item). */
  alt?: string;
  /** Frame shape. Default 16:10. */
  aspect?: MediaFrameAspect;
  /** A matted picture keeps the top clear of an overlay on the frame's top corner (a kind Tag). */
  clearTop?: boolean;
  /** Overlays on the frame's corners (a Tag, a checkbox); the owner positions them. */
  children?: ReactNode;
}

/**
 * Width/height band that spans the frame (contained, letterboxed on the matte): typical pictures (a product
 * shot, a square, a page view). Outside it (a heading strip, a tall column) a spanning picture is a
 * full-width band of page colour flush with the frame's edges, which reads as a spill, so it sits inset.
 */
const FILL_MIN_RATIO = 0.75;
const FILL_MAX_RATIO = 2.4;

/** `fill` (spans the frame) for typical shapes; `matte` (whole, inset on the matte) for extreme ones. */
export function mediaFrameFit(width: number, height: number): "fill" | "matte" {
  if (!(width > 0 && height > 0)) return "matte";
  const ratio = width / height;
  return ratio >= FILL_MIN_RATIO && ratio <= FILL_MAX_RATIO ? "fill" : "matte";
}

/**
 * A picture in a fixed-shape frame on the neutral matte. Every picture is whole (contain): a typical one
 * spans the frame, an extreme one (a wide strip, a tall column) sits inset with a hairline. Hidden until
 * its shape is known, so it never shows the wrong fit; a missing or broken picture is the empty matte.
 */
export function MediaFrame({ src, alt, aspect = "16:10", clearTop = false, children, className, ...props }: MediaFrameProps) {
  const [fit, setFit] = useState<{ src: string; fit: "fill" | "matte" | "failed" } | null>(null);
  const measure = useCallback((image: HTMLImageElement | null) => {
    if (src && image?.complete && image.naturalWidth) setFit({ src, fit: mediaFrameFit(image.naturalWidth, image.naturalHeight) });
  }, [src]);
  const state: MediaFrameState = !src ? "empty" : fit?.src === src ? fit.fit : "pending";
  return (
    <span className={cn(styles.frame, className)} data-slot="media-frame" data-aspect={aspect} data-fit={state}
      data-clear-top={clearTop ? "true" : undefined} {...props}>
      {src && state !== "failed" ? (
        <span className={styles.picture}>
          <img ref={measure} className={styles.image} src={src} alt={alt ?? ""} draggable={false}
            onLoad={(event) => measure(event.currentTarget)} onError={() => setFit({ src, fit: "failed" })} />
        </span>
      ) : null}
      {children}
    </span>
  );
}
