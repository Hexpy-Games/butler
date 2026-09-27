import type { ReactNode } from "react";
import styles from "./NavRow.module.css";

export interface NavRowSwapProps {
  /** What the trailing slot shows at rest (a status, a disclosure chevron); may be empty. */
  rest?: ReactNode;
  /** Revealed over `rest` while the row is hovered or holds keyboard focus (a row menu). */
  children: ReactNode;
  /** Keep the revealed content shown, for example while its menu is open. */
  open?: boolean;
}

/**
 * A trailing NavRow slot that swaps its rest content for row actions on row
 * hover and keyboard focus (fade on --motion-fast). Phones keep the rest
 * content (row menus open with a long press); touch pointers above phone
 * width show the actions when there is no rest content. Clicks inside never
 * reach the row.
 */
export function NavRowSwap({ rest, children, open = false }: NavRowSwapProps) {
  return (
    <span
      className={styles.swap}
      data-slot="nav-row-swap"
      data-open={open || undefined}
      data-has-rest={rest ? "true" : undefined}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {rest ? <span className={styles.swapRest}>{rest}</span> : null}
      <span className={styles.swapReveal}>{children}</span>
    </span>
  );
}
