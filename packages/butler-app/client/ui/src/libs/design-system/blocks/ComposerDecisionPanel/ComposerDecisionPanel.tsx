import type { HTMLAttributes, ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { Clickable } from "../../components/Clickable";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ComposerDecisionDetails } from "./ComposerDecisionDetails";
import styles from "./ComposerDecisionPanel.module.css";

export interface ComposerDecisionPanelProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "title" | "children"> {
  /** Decision-kind icon (secondary tone), e.g. ShieldCheck or ListChecks at size="lg". */
  icon: ReactNode;
  /** What is being decided; clamps to two lines and opens the source. */
  title: string;
  onOpen: () => void;
  /** Lines under the title (examples, a "+N more" line). Each wraps in full: what is decided is never cut. */
  details?: readonly string[];
  /** With `detailsShowLessLabel`, clamps long details to four lines behind an inline "Show more". */
  detailsShowMoreLabel?: string;
  detailsShowLessLabel?: string;
  /** Trailing subject-row content (a status Tag, a pending count, a compose-later button). */
  aside?: ReactNode;
  /** A failed decision, announced as an alert between the subject and the actions. */
  error?: string;
  /** The decision buttons, usually a ButtonContainer justify="end"; they take the composer radius. */
  actions: ReactNode;
}

/** A pending decision shown in place of the composer input: subject row, optional details and error, actions. */
export function ComposerDecisionPanel({ icon, title, onOpen, details, detailsShowMoreLabel, detailsShowLessLabel, aside, error, actions, className, ...props }: ComposerDecisionPanelProps) {
  const hasDetails = Boolean(details?.length);
  return (
    <div className={dsClass(styles.surface, className)} {...props}>
      <div className={styles.subject} data-slot="composer-decision-subject" data-has-details={hasDetails ? "true" : undefined}>
        {icon}
        <Stack.Item grow minWidth="0">
          <Clickable variant="text" onClick={onOpen} title={title}>
            <Typo.Label weight="medium" tone="primary" lineClamp={2} wrap="anywhere">{title}</Typo.Label>
          </Clickable>
        </Stack.Item>
        {aside ? <div className={styles.aside} data-slot="composer-decision-aside">{aside}</div> : null}
      </div>
      {hasDetails ? (
        <ComposerDecisionDetails lines={details!} showMoreLabel={detailsShowMoreLabel} showLessLabel={detailsShowLessLabel} />
      ) : null}
      {error ? (
        <div className={styles.error}>
          <Typo.Caption as="p" tone="secondary" role="alert">{error}</Typo.Caption>
        </div>
      ) : null}
      <div className={styles.actions} data-slot="composer-decision-actions">{actions}</div>
    </div>
  );
}
