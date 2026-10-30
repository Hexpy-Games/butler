import type { ReactNode } from "react";
import { Card } from "../../components/Card";
import { dsClass } from "../../lib/internal";
import type { StackDeckCardListeners } from "./StackDeck";
import styles from "./StackDeck.module.css";

export interface StackDeckCardToggle {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  /** The deck's focus target when it changes state. */
  focusTarget: boolean;
}

interface StackDeckCardProps {
  /** The card's one toggle; null: no toggle (a drag runs, or a single card). */
  toggle: StackDeckCardToggle | null;
  running: boolean;
  /** Decorative edges drawn past the card (inside the toggle, so a tap on one toggles). */
  edges?: ReactNode;
  listeners?: StackDeckCardListeners;
  children: ReactNode;
}

/**
 * A deck card. The Card itself is not interactive: one transparent toggle button covers it (the
 * stretched-link pattern) and the card content sits above it, so its own controls (grip, ⋯)
 * are siblings of the toggle, never inside it. Tab order: toggle, then the content's controls.
 * The toggle's focus ring is drawn on the Card.
 */
export function StackDeckCard({ toggle, running, edges, listeners, children }: StackDeckCardProps) {
  return (
    <Card className={dsClass(styles.card)} padding="md" interactive={toggle !== null}
      activity={running ? "running" : undefined} {...listeners}>
      {toggle ? (
        <button type="button" className={styles.toggle} aria-label={toggle.label} aria-expanded={toggle.expanded}
          onClick={toggle.onToggle} data-stack-deck-toggle={toggle.focusTarget ? "" : undefined}>
          {edges}
        </button>
      ) : edges ? <span className={styles.toggle} aria-hidden="true">{edges}</span> : null}
      <div className={styles.content}>{children}</div>
    </Card>
  );
}
