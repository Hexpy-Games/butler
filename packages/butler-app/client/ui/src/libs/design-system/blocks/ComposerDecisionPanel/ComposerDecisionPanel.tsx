import type { HTMLAttributes, ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { Clickable } from "../../components/Clickable";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import styles from "./ComposerDecisionPanel.module.css";

export interface ComposerDecisionPanelProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "title" | "children"> {
  /** Decision-kind icon (secondary tone), e.g. ShieldCheck or ListChecks at size="lg". */
  icon: ReactNode;
  /** What is being decided; clamps to two lines and opens the source. */
  title: string;
  onOpen: () => void;
  /** Trailing subject-row content (a pending count, a compose-later button). */
  aside?: ReactNode;
  /** A failed decision, announced as an alert between the subject and the actions. */
  error?: string;
  /** The decision buttons, usually a ButtonContainer justify="end"; they take the composer radius. */
  actions: ReactNode;
}

/** A pending decision shown in place of the composer input: subject row, optional error, actions. */
export function ComposerDecisionPanel({ icon, title, onOpen, aside, error, actions, className, ...props }: ComposerDecisionPanelProps) {
  return (
    <div className={dsClass(styles.surface, className)} {...props}>
      <div className={styles.subject} data-slot="composer-decision-subject">
        {icon}
        <Stack.Item grow minWidth="0">
          <Clickable variant="text" onClick={onOpen} title={title}>
            <Typo.Label weight="medium" tone="primary" lineClamp={2} wrap="anywhere">{title}</Typo.Label>
          </Clickable>
        </Stack.Item>
        {aside}
      </div>
      {error ? (
        <div className={styles.error}>
          <Typo.Caption as="p" tone="secondary" role="alert">{error}</Typo.Caption>
        </div>
      ) : null}
      <div className={styles.actions} data-slot="composer-decision-actions">{actions}</div>
    </div>
  );
}
