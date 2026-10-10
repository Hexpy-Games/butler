import type { HTMLAttributes, ReactNode } from "react";
import { IconSlot } from "../../components/IconSlot";
import { Typo } from "../../components/Typo";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { cn } from "../../lib/utils";
import styles from "./PageBand.module.css";

/**
 * `agent` Butler holds the tab (riso), `user` you hold it, `waiting` an approval waits, `warning` Butler
 * needs your input (keypad, MFA), `pick` element picking, `info` page events such as a blocked pop-up,
 * `idle` Butler can use the tab but holds nothing (no tint, quiet text: the row stays, nothing moves).
 */
export type PageBandTone = "agent" | "user" | "waiting" | "warning" | "pick" | "info" | "idle";

export interface PageBandProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "children" | "title"> {
  tone: PageBandTone;
  /** A 16px glyph or a small ButlerThinkingMark. */
  icon?: ReactNode;
  /** Who holds the page or what happens, in a few words ("Butler is browsing"). Never truncates. */
  label: ReactNode;
  /** The current step or the page event; the only part that truncates. */
  detail?: ReactNode;
  /** A quiet keyboard or gesture hint; hidden when the band is narrow. */
  hint?: ReactNode;
  /** Up to three `size="xs"` buttons in a `ButtonContainer size="xs"`. */
  actions?: ReactNode;
}

/**
 * One 40px line attached to the top of a PageCard for page-scoped state: who holds the tab, an
 * approval, a request for your input, picking, a blocked pop-up. The text is a polite live region;
 * the actions sit outside it.
 */
export function PageBand({ tone, icon, label, detail, hint, actions, className, ...props }: PageBandProps) {
  return (
    <div {...props} className={cn(styles.band, className)} data-slot="page-band" data-tone={tone}>
      <div className={styles.text} role="status" aria-live="polite">
        {icon ? <IconSlot size="md" className={dsClass(styles.icon)}>{icon}</IconSlot> : null}
        <Typo.Text weight="medium" className={dsClass(styles.label)}>{label}</Typo.Text>
        {detail ? (
          <>
            <span className={styles.separator} aria-hidden="true" />
            <Typo.Text tone="secondary" truncate className={dsClass(styles.detail)}>{detail}</Typo.Text>
          </>
        ) : null}
      </div>
      {hint ? <Typo.Text tone="tertiary" className={dsClass(styles.hint)}>{hint}</Typo.Text> : null}
      {actions ? <div className={styles.actions} data-slot="page-band-actions">{actions}</div> : null}
    </div>
  );
}
