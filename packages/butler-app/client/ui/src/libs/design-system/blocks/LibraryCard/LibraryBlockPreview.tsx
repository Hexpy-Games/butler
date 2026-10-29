import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import styles from "./LibraryCard.module.css";

/** The width a block scrap is laid out at before it is scaled into the card (a phone-wide answer column). */
const RENDER_WIDTH = 480;

/**
 * A block scrap's live mini render: the block laid out at RENDER_WIDTH, scaled to the card's media width,
 * inert (no focus, no pointer). It renders only once the card has come near the viewport, so a long 서랍
 * never lays out every block at once, and follows the theme like any other content.
 */
export function LibraryBlockPreview({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [scale, setScale] = useState(0);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const resize = new ResizeObserver(([entry]) => { if (entry) setScale(entry.contentRect.width / RENDER_WIDTH); });
    const intersect = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setNear(true);
      intersect.disconnect();
    }, { rootMargin: "50%" });
    resize.observe(element);
    intersect.observe(element);
    return () => { resize.disconnect(); intersect.disconnect(); };
  }, []);
  const style = { "--library-block-scale": scale, "--library-block-width": `${RENDER_WIDTH}px` } as CSSProperties;
  return (
    <span ref={ref} aria-hidden="true" className={styles.block} style={style}>
      {near && scale > 0 ? <span className={styles.blockContent} inert>{children}</span> : null}
    </span>
  );
}
