import { useEffect, useRef, useState, type CSSProperties } from "react";
import { LADDER_STAGGER, LADDER_START } from "./typeTimeline";
import t from "./TypographyHero.module.css";

/** Display to caption: the roles a Butler screen is built from, largest first. */
const ROLES = ["new-chat-title", "h1", "h3", "body", "caption"] as const;
/** tokens.css defaults, shown until the live values are read. */
const FALLBACK: Record<(typeof ROLES)[number], string> = {
  "new-chat-title": "48/51", h1: "32/40", h3: "20/27", body: "14/20", caption: "12/17",
};

function sizeAndLeading(element: Element): string | null {
  const style = getComputedStyle(element);
  const size = Number.parseFloat(style.fontSize);
  const leading = Number.parseFloat(style.lineHeight);
  return Number.isFinite(size) && Number.isFinite(leading) ? `${Math.round(size)}/${Math.round(leading)}` : null;
}

/**
 * Scene 2, the scale: the role ladder builds row by row, each specimen set in
 * its --typo-* role, while the size/leading of every role (read live from the
 * tokens) aligns in a tabular column on the right.
 */
export function ScaleScene() {
  const ref = useRef<HTMLDivElement>(null);
  const [labels, setLabels] = useState(FALLBACK);
  useEffect(() => {
    const samples = ref.current?.querySelectorAll<HTMLElement>("[data-role]");
    if (!samples || typeof getComputedStyle !== "function") return;
    const next = { ...FALLBACK };
    for (const sample of samples) {
      const role = sample.dataset.role as (typeof ROLES)[number];
      next[role] = sizeAndLeading(sample) ?? next[role];
    }
    setLabels(next);
  }, []);
  return (
    <div className={t.scene} data-scene="scale" ref={ref}>
      <div className={t.ladder}>
        {ROLES.map((role, index) => (
          <div className={t.rung} key={role} style={{ "--at": LADDER_START + index * LADDER_STAGGER } as CSSProperties}>
            <span className={t.rungSample} data-role={role} style={{
              "--size": `var(--typo-${role}-size)`, "--leading": `var(--typo-${role}-line-height)`, "--weight": `var(--typo-${role}-weight)`,
            } as CSSProperties}>Aa<span lang="ko">가</span></span>
            <span className={t.rungMeta}>
              <span className={t.code}>{role}</span>
              <span className={t.numbers}>{labels[role]}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
