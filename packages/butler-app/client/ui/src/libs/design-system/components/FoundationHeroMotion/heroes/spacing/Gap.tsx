import type { ReactNode } from "react";
import { type GapId } from "./spacingCopy";
import { Units } from "./Units";
import s from "./SpacingHero.module.css";

/**
 * A measured space: its blue highlight (`${name}-f`), sized by the live token
 * and anchored by CSS to what it sits against, and right of it one column of
 * 4px units exactly as tall as the space, with its label beside it.
 */
export function Gap({ id, n, name, label }: { id: GapId; n: number; name?: string; label?: ReactNode }) {
  return (
    <span className={s.gap} data-gap={id}>
      <span className={s.fill} data-t={name ? `${name}-f` : undefined} />
      <span className={s.col}>
        <Units n={n} name={name} />
        {label ? <span className={s.gapLabel}>{label}</span> : null}
      </span>
    </span>
  );
}
