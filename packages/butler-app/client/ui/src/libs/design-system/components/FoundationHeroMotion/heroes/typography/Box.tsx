import type { ReactNode } from "react";
import t from "./TypographyHero.module.css";

/** A box of the component the blueprint sketches (card, input, button). */
export function Box({ children }: { children: ReactNode }) {
  return <div className={t.sketchBox} data-sketch="">{children}</div>;
}
