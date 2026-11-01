import { useRef, type HTMLAttributes, type ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { Clickable } from "../../components/Clickable";
import { ComposerPanelFrame, ComposerPanelHeader, ComposerPanelBody, ComposerPanelActions, type ComposerPanelPlacement } from "../../lib/composerPanel";
import { useComposerPanelTransition } from "../../lib/useComposerPanelTransition";
import { composerDecisionKeyboard } from "../../lib/composerDecisionKeyboard";
import { Typo } from "../../components/Typo";
import { FieldError } from "../../components/Field";
import { dsClass } from "../../lib/internal";
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
  /** Optional display formatting; the full title and detail text remain available. */
  renderText?: (text: string) => ReactNode;
  /** The title and details are the exact action (commands, paths, URLs): drawn as their own characters (Typo `literal`). */
  literal?: boolean;
  /** Lines under the title (examples, a "+N more" line). Each wraps in full: what is decided is never cut. */
  details?: readonly string[];
  /** With `detailsShowLessLabel`, clamps long details to four lines behind an inline "Show more". */
  detailsShowMoreLabel?: string;
  detailsShowLessLabel?: string;
  /** Trailing subject-row content (a status Tag, a pending count, non-interactive metadata). */
  aside?: ReactNode;
  /** A failed decision, announced as an alert between the subject and the actions. */
  error?: string;
  /** The decision buttons, usually a ButtonContainer justify="end"; they take the composer radius (control radius in the conversation). */
  actions: ReactNode | ((complete: (action: () => void) => void) => ReactNode);
  /**
   * A 16:10 page thumbnail at the subject row's end (a `LiveTabFrame` of the tab the decision acts on): 144px wide,
   * 112px under 600px; under 420px it spans the text column under the details, cropped from the page's top to
   * `--decision-media-narrow-height` (140px). `onOpen` opens the page; without it the thumbnail is a plain image; `label` names it.
   */
  media?: ComposerDecisionMedia;
  /**
   * `composer` (default): in place of the composer input, inside ComposerCard. `conversation`: in the transcript,
   * inside a flat bordered `Card radius="lg"` with control-radius buttons.
   */
  placement?: ComposerPanelPlacement;
}

export interface ComposerDecisionMedia {
  content: ReactNode;
  label: string;
  onOpen?: () => void;
}

function DecisionMedia({ content, label, onOpen }: ComposerDecisionMedia) {
  return <div className={styles.media} data-slot="composer-decision-media">
    {onOpen ? <Clickable className={dsClass(styles.mediaTarget)} onClick={onOpen} aria-label={label} title={label}>{content}</Clickable>
      : <div className={styles.mediaTarget} role="img" aria-label={label}>{content}</div>}
  </div>;
}

/** A pending decision shown in place of the composer input: subject row, optional details and error, media, actions. */
export function ComposerDecisionPanel({ icon, eyebrow, title, onOpen, details, detailsShowMoreLabel, detailsShowLessLabel, aside, error, actions, media, renderText, literal, placement, className, onKeyDown, ...props }: ComposerDecisionPanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  const { defer, deferring } = useComposerPanelTransition(panel);
  const hasDetails = Boolean(details?.length);
  return <ComposerPanelFrame panelRef={panel} placement={placement} className={media ? dsClass(styles.withMedia, className) : className} tabIndex={0} aria-label={title} aria-busy={deferring}
    onKeyDown={(event) => { if (deferring) { event.preventDefault(); event.stopPropagation(); return; } composerDecisionKeyboard(event); onKeyDown?.(event); }} {...props}>
    <ComposerPanelHeader icon={icon} eyebrow={eyebrow} dataSlot="composer-decision-subject" hasDetails={hasDetails}
      title={<Clickable variant="text" onClick={onOpen} title={title}>
        <Typo.Label weight="medium" tone="primary" wrap="anywhere" literal={literal}>{renderText ? renderText(title) : title}</Typo.Label>
      </Clickable>} aside={aside} />
    {hasDetails && <ComposerPanelBody dataSlot="decision-details-scroll" single>
      <ComposerDecisionDetails lines={details!} renderText={renderText} literal={literal} showMoreLabel={detailsShowMoreLabel} showLessLabel={detailsShowLessLabel} />
    </ComposerPanelBody>}
    {error && <FieldError className={dsClass(styles.error)}><Typo.Caption as="p" tone="inherit">{error}</Typo.Caption></FieldError>}
    {media && <DecisionMedia {...media} />}
    <ComposerPanelActions dataSlot="composer-decision-actions">{typeof actions === "function" ? actions(defer) : actions}</ComposerPanelActions>
  </ComposerPanelFrame>;
}
