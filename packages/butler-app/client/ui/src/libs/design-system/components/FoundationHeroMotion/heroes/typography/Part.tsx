import type { ReactNode } from "react";
import t from "./TypographyHero.module.css";

/** A non-text piece of a component (control, icon, second card), shown with its text line; `sketch` marks its box for the blueprint. */
export function Part({ name, block = false, sketch = false, children }: { name: string; block?: boolean; sketch?: boolean; children: ReactNode }) {
  const mark = sketch ? "" : undefined;
  return block
    ? <div className={t.part} data-block="" data-sketch={mark} data-t={name}>{children}</div>
    : <span className={t.part} data-sketch={mark} data-t={name}>{children}</span>;
}
