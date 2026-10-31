import type { DsBaseProps } from "../../lib/dsProps";
import { useLayoutEffect, useRef, useState, type HTMLAttributes, type MouseEventHandler, type ReactNode, type TouchEventHandler } from "react";
import { useEnteringKeys } from "../../lib/useEnteringKeys";
import { cn } from "../../lib/utils";
import { StackDeckCard } from "./StackDeckCard";
import { StackDeckColumn } from "./StackDeckColumn";
import { STACK_DECK_LABELS, type StackDeckLabels } from "./stackDeckLabels";
import styles from "./StackDeck.module.css";

export interface StackDeckItem {
  /** Stable id (React key). */
  id: string;
  /** Name for the deck's and cards' accessible names (usually the card title). */
  label: string;
  /** Running: the card takes the running state, and a collapsed deck's edges the running colour. */
  running?: boolean;
}

export interface StackDeckCardContext {
  /** Place in the deck (0: the front card). */
  index: number;
  /** Cards in the deck (the front card says “외 N건”). */
  count: number;
  expanded: boolean;
  /**
   * Controls in the card (grip, ⋯) are siblings of the card's toggle, drawn above it, and their
   * own tab stops after it. With `cardListeners`, they stop their own mouse-down and touch-start.
   */
  interactive: boolean;
}

/** Pointer handlers a card forwards, such as a drag sensor's listeners. */
export interface StackDeckCardListeners {
  onMouseDown?: MouseEventHandler<HTMLDivElement>;
  onTouchStart?: TouchEventHandler<HTMLDivElement>;
}

export interface StackDeckProps<TItem extends StackDeckItem>
  extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "children"> {
  /** The cards, front first. One item renders a plain card. */
  items: readonly TItem[];
  /** Card content (a row's anatomy); the deck draws the Card around it. */
  renderCard: (item: TItem, context: StackDeckCardContext) => ReactNode;
  /** Controlled open state. */
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Localized accessible names; English by default. */
  labels?: Partial<StackDeckLabels>;
  /** False while a drag runs: cards have no toggle and show no hover. Default true. */
  interactive?: boolean;
  /** Pointer handlers per card (`null`: the collapsed deck), e.g. to drag a card or the whole deck. */
  cardListeners?: (item: TItem | null) => StackDeckCardListeners | undefined;
}

/** Edges a collapsed deck shows on its right; the rest are only in the front card's count. */
const MAX_PEEKS = 3;

/**
 * A 묶음 (stack) of cards that run together. Collapsed, the front card is a normal full-width row
 * whose toggle covers it; one hairline edge per further card (up to three) shows past its right
 * side. A tap, or Enter or Space on the toggle, opens the cards into a column, one full-width
 * card per item in order (StackDeckColumn); the cards slide down from behind the front card.
 */
export function StackDeck<TItem extends StackDeckItem>({
  items, renderCard, expanded: controlled, defaultExpanded = false, onExpandedChange, labels: overrides,
  interactive = true, cardListeners, className, ...props
}: StackDeckProps<TItem>) {
  const labels = { ...STACK_DECK_LABELS, ...overrides };
  const [own, setOwn] = useState(defaultExpanded);
  const root = useRef<HTMLDivElement | null>(null);
  const refocus = useRef(false);
  const opened = useRef(false);
  const many = items.length > 1;
  const expanded = many && (controlled ?? own);
  const extras = items.slice(1, MAX_PEEKS + 1).map((item) => item.id);
  const entering = useEnteringKeys(extras, "stack-deck");
  const front = items[0];

  const change = (next: boolean) => {
    refocus.current = Boolean(root.current?.contains(document.activeElement));
    opened.current = next;
    setOwn(next);
    onExpandedChange?.(next);
  };
  // The toggle is another element in each state; keyboard focus follows it.
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    root.current?.querySelector<HTMLElement>("[data-stack-deck-toggle]")?.focus();
  }, [expanded]);

  if (!front) return null;
  const live = items.some((item) => item.running);
  const toggle = many && interactive;
  return (
    <div ref={root} className={cn(styles.deck, className)} data-slot="stack-deck" data-state={expanded ? "expanded" : "collapsed"} {...props}>
      {expanded ? (
        <StackDeckColumn items={items} renderCard={renderCard} labels={labels} interactive={interactive}
          cardListeners={cardListeners} enter={opened.current} onCollapse={() => change(false)} />
      ) : (
        <div className={styles.front} data-running={live || undefined} data-stack-deck-front="">
          <StackDeckCard running={live} listeners={cardListeners?.(many ? null : front)}
            toggle={toggle ? { label: labels.expand(items.length, front.label), expanded: false, onToggle: () => change(true), focusTarget: true } : null}
            edges={extras.length ? extras.map((key, index) => (
              <span key={key} aria-hidden="true" className={styles.peek} data-i={index + 1} data-entering={entering.has(key) || undefined} />
            )) : null}>
            {renderCard(front, { index: 0, count: items.length, expanded: false, interactive: true })}
          </StackDeckCard>
        </div>
      )}
    </div>
  );
}
