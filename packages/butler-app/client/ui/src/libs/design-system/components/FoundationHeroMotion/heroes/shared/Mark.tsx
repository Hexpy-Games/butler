import type { ReactNode } from "react";
import c from "./ChapterHero.module.css";

/**
 * Marks a piece of a real component for the hero: `n` names it for guides and
 * badges (measured, never reflowed), `part` makes it appear with its step's
 * text, `sweep` makes it appear left to right through a window instead (a
 * field whose value is text inside the control), `fill` fades its color in
 * over its blueprint outline, `sketch` adds its rounded
 * box to the blueprint. A mark is a plain wrapper (inline-grid, or grid with
 * `block`) so the component keeps its own spacing.
 */
export function Mark({ n, part = false, sweep = false, fill = false, sketch = false, block = false, children }: {
  n: string; part?: boolean; sweep?: boolean; fill?: boolean; sketch?: boolean; block?: boolean; children: ReactNode;
}) {
  const Tag = block ? "div" : "span";
  const shows = part || sweep || fill;
  return (
    <Tag className={sweep ? c.markSweep : block ? c.markBlock : c.mark} data-a={n} data-block={block ? "" : undefined} data-fill={fill ? "" : undefined} data-part={shows ? n : undefined}
      data-sketch={sketch ? "" : undefined} data-sweep={sweep ? "" : undefined} data-t={shows ? `p-${n}` : undefined}>
      {sweep ? <Tag className={c.markSweepIn} data-t={`p-${n}-in`}>{children}</Tag> : children}
    </Tag>
  );
}
