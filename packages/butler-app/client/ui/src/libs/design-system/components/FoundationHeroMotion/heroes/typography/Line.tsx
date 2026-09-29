import type { ReactNode } from "react";
import t from "./TypographyHero.module.css";

/** A text line of a component, revealed during its build (see typeLines.ts). */
export function Line({ id, block = false, children }: { id: string; block?: boolean; children: ReactNode }) {
  return block
    ? <div className={t.line} data-block="" data-line={id} data-t={`line-${id}`}>{children}</div>
    : <span className={t.line} data-line={id} data-t={`line-${id}`}>{children}</span>;
}
