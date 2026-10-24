// ExpandableText.
// Text clamped to `collapsedLines` that, only when it really overflows, becomes one toggle (a button with
// aria-expanded, Enter/Space) and grows in place. One text node, never swapped: the clamp is lifted at the
// start of the expand and the box animates its own measured height (DS --motion-base, standard easing);
// a collapse animates back to the clamped height and re-applies the clamp at the end. Line breaks never
// change (the clamp wraps normally), so the first line stays put and rows below slide. Reduced motion:
// instant. Optional `meta` is a caption line above the text, so the text column has one width in every row.
// The open cue follows the DS trailing disclosure chevron (DisclosureRow affordance="trailing",
// DisclosureRow.module.css .turn): ChevronRight sm, --text-tertiary, a line-high slot, turns 90° to point
// down when open over --motion-fast standard easing, no travel under reduced motion. The slot is kept in
// every row, empty when the text fits.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ChevronRight } from "../Icons";
import styles from "./ExpandableText.module.css";

export interface ExpandableTextProps {
  /** Plain text; line breaks are kept and long words or URLs wrap anywhere. */
  children: string;
  /** Lines shown while collapsed (default 1). */
  collapsedLines?: 1 | 2 | 3;
  /** A short caption line above the text (scope, date). */
  meta?: ReactNode;
  id?: string;
}

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function ExpandableText({ children, collapsedLines = 1, meta, id }: ExpandableTextProps) {
  const box = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(true);
  const run = useRef(0);
  const generatedId = useId();
  const textId = id ?? generatedId;
  // An unmount mid-animation drops the pending finish (its token no longer matches).
  useEffect(() => () => { run.current += 1; }, []);

  // Overflow is measured only while clamped: more text than the clamped lines makes the row a toggle.
  useLayoutEffect(() => {
    const node = text.current;
    if (!node || !clamped) return;
    const check = () => setOverflows(node.scrollHeight > node.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(node);
    return () => observer.disconnect();
  }, [children, clamped]);

  const animate = useCallback((from: number, to: number, done: () => void) => {
    const node = box.current;
    const token = ++run.current;
    if (!node || reduced() || from === to) { done(); if (node) node.style.height = ""; return; }
    node.style.height = `${from}px`;
    void node.offsetHeight; // commit the start height before the transition
    node.dataset.animating = "true";
    node.style.height = `${to}px`;
    const finish = () => {
      if (token !== run.current) return;
      node.removeEventListener("transitionend", onEnd);
      // Finish the state change first (a collapse re-applies the clamp), then release the fixed height,
      // so no frame ever shows the unclamped text at its natural height.
      done();
      delete node.dataset.animating;
      node.style.height = "";
    };
    const onEnd = (event: TransitionEvent) => { if (event.target === node && event.propertyName === "height") finish(); };
    node.addEventListener("transitionend", onEnd);
    const seconds = Number.parseFloat(getComputedStyle(node).transitionDuration) || 0;
    window.setTimeout(finish, seconds * 1000 + 80);
  }, []);

  const toggle = () => {
    const node = box.current;
    const line = text.current;
    if (!node || !line) return;
    if (!expanded) {
      const from = node.getBoundingClientRect().height;
      flushSync(() => { setClamped(false); setExpanded(true); });
      animate(from, line.scrollHeight, () => undefined);
    } else {
      const from = node.getBoundingClientRect().height;
      const to = Number.parseFloat(getComputedStyle(line).lineHeight) * collapsedLines;
      setExpanded(false);
      animate(from, to, () => flushSync(() => setClamped(true)));
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    toggle();
  };

  return (
    <div className={styles.root} data-slot="expandable-text" data-interactive={overflows ? "" : undefined} data-expanded={expanded ? "" : undefined}
      role={overflows ? "button" : undefined} tabIndex={overflows ? 0 : undefined} aria-expanded={overflows ? expanded : undefined}
      aria-controls={overflows ? textId : undefined} onClick={overflows ? toggle : undefined} onKeyDown={overflows ? onKeyDown : undefined}>
      <div className={styles.layout} data-meta={meta ? "" : undefined}>
        {meta ? <span className={styles.meta}>{meta}</span> : null}
        <div ref={box} className={styles.box}>
          <span ref={text} id={textId} className={styles.text} data-clamped={clamped ? String(collapsedLines) : undefined}>{children}</span>
        </div>
        <span className={styles.chevron} aria-hidden="true" data-open={expanded ? "true" : undefined}>{overflows ? <ChevronRight size="sm" /> : null}</span>
      </div>
    </div>
  );
}
