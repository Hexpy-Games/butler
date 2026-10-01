import { useRef, type HTMLAttributes, type ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { Clickable } from "../../components/Clickable";
import { ComposerPanelFrame, ComposerPanelHeader, ComposerPanelBody, ComposerPanelActions } from "../../lib/composerPanel";
import { useComposerPanelTransition } from "../../lib/useComposerPanelTransition";
import { composerDecisionKeyboard } from "../../lib/composerDecisionKeyboard";
import { Typo } from "../../components/Typo";
import { ComposerDecisionDetails } from "./ComposerDecisionDetails";
import styles from "./ComposerDecisionPanel.module.css";

export interface ComposerDecisionPanelProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "title" | "children"> {
  /** Decision-kind icon (secondary tone), e.g. ShieldCheck or ListChecks; the shared header sets size. */
  icon: ReactNode;
  /** Localized decision category above the fully readable title. */
  eyebrow?: string;
  /** What is being decided; wraps in full and opens the source. */
  title: string;
  onOpen: () => void;
  /** Lines under the title (examples, a "+N more" line). Each wraps in full: what is decided is never cut. */
  details?: readonly string[];
  /** With `detailsShowLessLabel`, clamps long details to four lines behind an inline "Show more". */
  detailsShowMoreLabel?: string;
  detailsShowLessLabel?: string;
  /** Trailing subject-row content (a status Tag, a pending count, non-interactive metadata). */
  aside?: ReactNode;
  /** A failed decision, announced as an alert between the subject and the actions. */
  error?: string;
  /** The decision buttons, usually a ButtonContainer justify="end"; they take the composer radius. */
  actions: ReactNode | ((complete: (action: () => void) => void) => ReactNode);
}

/** A pending decision shown in place of the composer input: subject row, optional details and error, actions. */
export function ComposerDecisionPanel({ icon, eyebrow, title, onOpen, details, detailsShowMoreLabel, detailsShowLessLabel, aside, error, actions, className, onKeyDown, ...props }: ComposerDecisionPanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  const { defer, deferring } = useComposerPanelTransition(panel);
  const hasDetails = Boolean(details?.length);
  return <ComposerPanelFrame panelRef={panel} className={className} tabIndex={0} aria-label={title} aria-busy={deferring}
    onKeyDown={(event) => { if (deferring) { event.preventDefault(); event.stopPropagation(); return; } composerDecisionKeyboard(event); onKeyDown?.(event); }} {...props}>
    <ComposerPanelHeader icon={icon} eyebrow={eyebrow} dataSlot="composer-decision-subject" hasDetails={hasDetails}
      title={<Clickable variant="text" onClick={onOpen} title={title}>
        <Typo.Label weight="medium" tone="primary" wrap="anywhere">{title}</Typo.Label>
      </Clickable>} aside={aside} />
    {hasDetails && <ComposerPanelBody dataSlot="decision-details-scroll" single>
      <ComposerDecisionDetails lines={details!} showMoreLabel={detailsShowMoreLabel} showLessLabel={detailsShowLessLabel} />
    </ComposerPanelBody>}
    {error && <div className={styles.error}><Typo.Caption as="p" tone="secondary" role="alert">{error}</Typo.Caption></div>}
    <ComposerPanelActions dataSlot="composer-decision-actions">{typeof actions === "function" ? actions(defer) : actions}</ComposerPanelActions>
  </ComposerPanelFrame>;
}
