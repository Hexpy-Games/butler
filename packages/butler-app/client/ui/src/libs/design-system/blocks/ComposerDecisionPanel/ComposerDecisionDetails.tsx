import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Typo } from "../../components/Typo";
import styles from "./ComposerDecisionPanel.module.css";

/** Lines shown before "Show more" when the owner passes both labels. */
const CLAMP_LINES = 4;

/**
 * The detail lines under a decision's title. Every line wraps, so nothing is
 * cut; with `showMoreLabel` and `showLessLabel` a long block clamps and an
 * inline button reveals the rest (the QueuedMessage pattern).
 */
export function ComposerDecisionDetails({ lines, showMoreLabel, showLessLabel }: {
  lines: readonly string[];
  showMoreLabel?: string;
  showLessLabel?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const clamp = Boolean(showMoreLabel && showLessLabel);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!clamp || !node) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(window.getComputedStyle(node).lineHeight);
      setOverflowing(Number.isFinite(lineHeight) && node.scrollHeight > lineHeight * CLAMP_LINES + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [clamp, lines]);
  return (
    <div className={styles.details} data-slot="composer-decision-details">
      <div id={id} ref={ref} className={styles.detailLines} data-clamped={clamp && !expanded ? "true" : undefined}>
        {lines.map((line, index) => (
          <Typo.Caption key={`${index}:${line}`} as="p" tone="secondary" wrap="anywhere">{line}</Typo.Caption>
        ))}
      </div>
      {clamp && (overflowing || expanded) ? (
        <Button type="button" variant="inline" aria-controls={id} aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}>
          {expanded ? showLessLabel : showMoreLabel}
        </Button>
      ) : null}
    </div>
  );
}
