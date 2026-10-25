import { useCallback, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { useReducedMotion } from "../../lib/useReducedMotion";
import { cn } from "../../lib/utils";
import { ImageIcon } from "../Icons";
import styles from "./MediaFrame.module.css";

/** Frame shapes, width:height. */
export type MediaFrameAspect = "1:1" | "4:5" | "3:4" | "16:10" | "16:9";

/** `pending` until the picture's shape is known; `cover` crops to the frame; `failed` on a load error; `empty` without a picture. */
export type MediaFrameState = "pending" | "fill" | "matte" | "cover" | "failed" | "empty";

/** `contain` keeps every picture whole (fill or matte by shape); `cover` fills the frame, cropped from the center. */
export type MediaFrameFit = "contain" | "cover";

export interface MediaFrameProps extends DsBaseProps<HTMLAttributes<HTMLSpanElement>> {
  /** Picture URL. Omitted: an empty matte of the same shape. */
  src?: string;
  /** Alternative text. Default "" (decorative: the owning title names the item). */
  alt?: string;
  /** Frame shape. Default 16:10. Ignored with `natural`. */
  aspect?: MediaFrameAspect;
  /**
   * The picture's own display size in CSS px (its pixel size divided by its pixel ratio). The frame takes the
   * picture's exact shape and is never wider than this width: a small picture stays small, a large one shrinks
   * to its container. The shape is reserved before the picture loads, so nothing shifts.
   */
  natural?: { width: number; height: number };
  /** How the picture meets the frame. Default `contain`. */
  fit?: MediaFrameFit;
  /** A missing or broken picture shows a tinted placeholder with a centered icon instead of the bare matte. */
  placeholder?: boolean;
  /** The placeholder's icon: a favicon URL, on a light plate. Omitted or broken: an image glyph. */
  placeholderIcon?: string;
  /** A matted picture keeps the top clear of an overlay on the frame's top corner (a kind Tag). */
  clearTop?: boolean;
  /** Forces reduced motion (the picture appears without its load fade) on or off; defaults to the OS and app setting. */
  reducedMotion?: boolean;
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

/** The placeholder's centered mark: the favicon on a light plate, or the image glyph without one. */
function Placeholder({ icon }: { icon?: string }) {
  const [brokenIcon, setBrokenIcon] = useState<string | null>(null);
  const favicon = icon && brokenIcon !== icon;
  return (
    <span className={styles.placeholder} data-slot="media-frame-placeholder" data-icon={favicon ? "favicon" : "glyph"} aria-hidden="true">
      {favicon ? (
        <span className={styles.plate}>
          <img className={styles.favicon} src={icon} alt="" draggable={false} onError={() => setBrokenIcon(icon)} />
        </span>
      ) : <span className={styles.glyph}><ImageIcon size="xl" /></span>}
    </span>
  );
}

/**
 * A picture in a fixed-shape frame on the neutral matte. By default every picture is whole (contain): a
 * typical one spans the frame, an extreme one (a wide strip, a tall column) sits inset with a hairline.
 * Hidden until its shape is known, so it never shows the wrong fit. `fit="cover"` fills the frame from the
 * center instead. A missing or broken picture is the empty matte, or the tinted placeholder when asked.
 * The matte holds the shape while the picture loads; the picture then fades in over it
 * (`--motion-slow`, at once under reduced motion), and a failed one's placeholder fades in.
 */
export function MediaFrame({
  src, alt, aspect = "16:10", natural, fit: fitMode = "contain", placeholder = false, placeholderIcon, clearTop = false, reducedMotion, children, className, ...props
}: MediaFrameProps) {
  const [fit, setFit] = useState<{ src: string; fit: "fill" | "matte" | "failed" } | null>(null);
  const shaped = Boolean(natural && natural.width > 0 && natural.height > 0);
  const measure = useCallback((image: HTMLImageElement | null) => {
    // A frame in the picture's own shape always spans it; no matte inset is needed.
    if (src && image?.complete && image.naturalWidth) setFit({ src, fit: shaped ? "fill" : mediaFrameFit(image.naturalWidth, image.naturalHeight) });
  }, [src, shaped]);
  const known = fit && fit.src === src ? fit.fit : undefined;
  const state: MediaFrameState = !src ? "empty" : known === "failed" ? "failed" : fitMode === "cover" ? "cover" : known ?? "pending";
  const missing = placeholder && (state === "empty" || state === "failed");
  // A picture already decoded when it mounts (a cached one) is known before the first paint and shows at once.
  const loaded = known === "fill" || known === "matte";
  const systemReduced = useReducedMotion();
  const reduced = reducedMotion ?? systemReduced;
  const shape = shaped && natural
    ? { "--media-natural-width": `${natural.width}px`, "--media-natural-ratio": `${natural.width} / ${natural.height}` } as CSSProperties
    : undefined;
  return (
    <span className={cn(styles.frame, className)} data-slot="media-frame" data-aspect={shaped ? undefined : aspect}
      data-natural={shaped ? "true" : undefined} style={shape} data-fit={state}
      data-loaded={loaded ? "true" : undefined} data-reduced={reduced ? "true" : undefined} data-placeholder={missing ? "true" : undefined}
      data-clear-top={clearTop ? "true" : undefined} {...props}>
      {src && state !== "failed" ? (
        <span className={styles.picture}>
          <img ref={measure} className={styles.image} src={src} alt={alt ?? ""} draggable={false}
            onLoad={(event) => measure(event.currentTarget)} onError={() => setFit({ src, fit: "failed" })} />
        </span>
      ) : null}
      {missing ? <Placeholder icon={placeholderIcon} /> : null}
      {children}
    </span>
  );
}
