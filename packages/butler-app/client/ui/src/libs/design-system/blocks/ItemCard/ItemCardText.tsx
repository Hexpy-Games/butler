import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import styles from "./ItemCard.module.css";

/**
 * The card's plain text. A vertical card clamps it (`--item-card-text-clamp` from the card's container
 * query); with both labels an inline button reveals the rest. A row card shows it whole, so it never
 * offers Show more there.
 */
export function ItemCardText({ text, showMoreLabel, showLessLabel }: { text: string; showMoreLabel?: string; showLessLabel?: string }) {
  const id = useId();
  const ref = useRef<HTMLParagraphElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [clampable, setClampable] = useState(false);
  const toggle = Boolean(showMoreLabel && showLessLabel);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!toggle || !node) return;
    const measure = () => {
      const style = window.getComputedStyle(node);
      const lines = Number.parseInt(style.getPropertyValue("--item-card-text-clamp"), 10);
      const lineHeight = Number.parseFloat(style.lineHeight);
      setClampable(Number.isFinite(lines) && Number.isFinite(lineHeight) && node.scrollHeight > lineHeight * lines + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [toggle, text]);
  return (
    <span className={styles.textBlock}>
      <p id={id} ref={ref} className={styles.text} data-expanded={expanded ? "true" : undefined}>{text}</p>
      {toggle && clampable ? (
        <Button type="button" variant="inline" aria-controls={id} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? showLessLabel : showMoreLabel}
        </Button>
      ) : null}
    </span>
  );
}
