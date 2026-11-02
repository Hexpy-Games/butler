import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/Button";
import { Typo } from "../../components/Typo";
import { dsClass } from "../../lib/internal";
import { useScrollEdges } from "../../lib/useScrollEdges";
import styles from "./ComposerDecisionPanel.module.css";

/** A detail line, or `{ code }`: a command body drawn in a code frame with its own spaces and line breaks. */
export type ComposerDecisionDetail = string | { code: string };
/** Display formatting for the title and detail lines; `code` for a `{ code }` detail. */
export type ComposerDecisionRenderText = (text: string, as: "text" | "code") => ReactNode;

/** The markdown code frame's look: monospace, whitespace kept; every edge with hidden content fades (long lines, a tall script). */
function DetailCode({ code, renderText, literal }: { code: string; renderText?: ComposerDecisionRenderText; literal?: boolean }) {
  const fade = useScrollEdges("both");
  return <div className={styles.code} data-slot="composer-decision-code">
    <Typo.Code as="pre" ref={fade} dir="ltr" tone="secondary" literal={literal} className={dsClass(styles.codeText)}>
      {renderText ? renderText(code, "code") : code}
    </Typo.Code>
  </div>;
}

/**
 * The detail lines under a decision's title. Every line wraps, so nothing is
 * cut; with `showMoreLabel` and `showLessLabel` a long block clamps and an
 * inline button reveals the rest (the QueuedMessage pattern).
 */
export function ComposerDecisionDetails({ lines, showMoreLabel, showLessLabel, renderText, literal }: {
  lines: readonly ComposerDecisionDetail[];
  renderText?: ComposerDecisionRenderText;
  literal?: boolean;
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
      const clamped = node.getAttribute("data-clamped");
      if (clamped !== "true") return;
      const visibleHeight = node.clientHeight;
      // A multi-paragraph line clamp can hide entire later blocks from scrollHeight.
      // Compare actual heights, restoring the clamp synchronously before paint.
      node.removeAttribute("data-clamped");
      const fullHeight = node.scrollHeight;
      node.setAttribute("data-clamped", clamped);
      setOverflowing(fullHeight > visibleHeight + 1);
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
        {lines.map((line, index) => typeof line === "string"
          ? <Typo.Caption key={`${index}:${line}`} as="p" tone="secondary" wrap="anywhere" literal={literal} title={line}>{renderText ? renderText(line, "text") : line}</Typo.Caption>
          : <DetailCode key={`${index}:${line.code}`} code={line.code} renderText={renderText} literal={literal} />)}
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
