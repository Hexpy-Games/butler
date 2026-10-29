import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { animateMotion } from "../../lib/motion";
import type { StackDeckCardContext, StackDeckCardListeners, StackDeckItem } from "./StackDeck";
import { StackDeckCard } from "./StackDeckCard";
import type { StackDeckLabels } from "./stackDeckLabels";
import styles from "./StackDeck.module.css";

/** Cards past this index share the last stacking class. */
const MAX_INDEX = 7;

export interface StackDeckColumnProps<TItem extends StackDeckItem> {
  items: readonly TItem[];
  renderCard: (item: TItem, context: StackDeckCardContext) => ReactNode;
  labels: StackDeckLabels;
  interactive: boolean;
  cardListeners?: (item: TItem | null) => StackDeckCardListeners | undefined;
  /** The deck was just opened: the cards slide out from behind the front card. */
  enter: boolean;
  /** The fold motion finished: render the collapsed deck. */
  onCollapse: () => void;
}

/**
 * Slides every card after the first between the front card's place (stacked) and its own place
 * in the column (FLIP on `translate`), fading over the first third so a card never shows past the
 * front. Reduced motion: animateMotion keeps only the fade.
 */
function slide(column: HTMLElement | null, direction: "open" | "fold"): Animation[] {
  const cards = column ? [...column.querySelectorAll<HTMLElement>(":scope > [data-stack-deck-card]")] : [];
  const front = cards[0];
  if (!front) return [];
  return cards.slice(1).flatMap((card) => {
    const stacked = { translate: `0 ${front.offsetTop - card.offsetTop}px`, opacity: 0 };
    const placed = { translate: "0 0", opacity: 1 };
    const frames = direction === "open"
      ? [stacked, { opacity: 1, offset: 0.35 }, placed]
      : [placed, { opacity: 1, offset: 0.65 }, stacked];
    // Opening settles into place (emphasized); stacking speeds up into the front card (accelerate), so
    // the collapsed deck follows the moment the cards arrive.
    const animation = direction === "open"
      ? animateMotion(card, frames, { duration: "slow", easing: "emphasized" })
      : animateMotion(card, frames, { duration: "slow", easing: "accelerate", fill: "forwards" });
    return animation ? [animation] : [];
  });
}

/**
 * The 묶음 opened into a column: every card at the full row width, in order, a hairline gap
 * apart. The cards slide down from behind the front card on open; each card's toggle (a tap on the
 * card, or Escape) slides them back up behind it before the collapsed deck returns.
 */
export function StackDeckColumn<TItem extends StackDeckItem>({ items, renderCard, labels, interactive, cardListeners, enter, onCollapse }: StackDeckColumnProps<TItem>) {
  const column = useRef<HTMLDivElement | null>(null);
  const running = useRef<Animation[]>([]);
  const folding = useRef(false);
  // The column mounts per open, so `enter` is read once.
  const opening = useRef(enter);
  useLayoutEffect(() => {
    if (opening.current) running.current = slide(column.current, "open");
  }, []);
  useEffect(() => () => { for (const animation of running.current) animation.cancel(); }, []);
  const fold = () => {
    if (folding.current) return;
    folding.current = true;
    for (const animation of running.current) animation.cancel();
    running.current = slide(column.current, "fold");
    if (!running.current.length) { onCollapse(); return; }
    void Promise.all(running.current.map((animation) => animation.finished)).then(onCollapse, () => undefined);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    fold();
  };
  return (
    <div ref={column} className={styles.column} role="list" data-slot="stack-deck-list" onKeyDown={onKeyDown}>
      {items.map((item, index) => (
        <div key={item.id} role="listitem" className={styles.item} data-i={Math.min(index, MAX_INDEX)} data-stack-deck-card="">
          <StackDeckCard running={Boolean(item.running)} listeners={cardListeners?.(item)}
            toggle={interactive ? { label: labels.fold(item.label), expanded: true, onToggle: fold, focusTarget: index === 0 } : null}>
            {renderCard(item, { index, count: items.length, expanded: true, interactive: true })}
          </StackDeckCard>
        </div>
      ))}
    </div>
  );
}
