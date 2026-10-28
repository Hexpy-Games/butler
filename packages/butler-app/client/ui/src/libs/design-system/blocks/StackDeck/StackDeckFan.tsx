import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { motionDuration, prefersReducedMotion } from "../../lib/motion";
import { ScrollArea } from "../ScrollArea";
import type { StackDeckCardContext, StackDeckCardListeners, StackDeckItem } from "./StackDeck";
import { StackDeckCard } from "./StackDeckCard";
import type { StackDeckLabels } from "./stackDeckLabels";
import { useStackDeckSnap } from "./useStackDeckSnap";
import styles from "./StackDeck.module.css";

/** Edges drawn per side for cards out of view. */
const MAX_EDGES = 3;
/** Cards past this index share the last fan-out offset class. */
const MAX_FAN_INDEX = 7;

export interface StackDeckFanProps<TItem extends StackDeckItem> {
  items: readonly TItem[];
  renderCard: (item: TItem, context: StackDeckCardContext) => ReactNode;
  labels: StackDeckLabels;
  interactive: boolean;
  cardListeners?: (item: TItem | null) => StackDeckCardListeners | undefined;
  /** The fold motion finished: render the collapsed deck. */
  onCollapse: () => void;
}

/** The deck's own edges on the open row: one per card out of view (up to three), on the side it is hidden. */
function RowEdges({ count, side }: { count: number; side: "start" | "end" }) {
  return (
    <>
      {Array.from({ length: Math.min(MAX_EDGES, count) }, (_, index) => (
        <span key={index} aria-hidden="true" className={styles.peek} data-i={index + 1} data-side={side} />
      ))}
    </>
  );
}

/**
 * The 묶음 fanned out to the right in the same row (a horizontal ScrollArea): two cards fill the
 * row; with more it scrolls, settles on whole cards and shows one deck edge per hidden card at
 * either end. Each card's toggle (a tap on the card, or Escape) slides the cards back into the deck.
 */
export function StackDeckFan<TItem extends StackDeckItem>({ items, renderCard, labels, interactive, cardListeners, onCollapse }: StackDeckFanProps<TItem>) {
  const [folding, setFolding] = useState(false);
  const timer = useRef(0);
  const snap = useStackDeckSnap(items.length);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const fold = () => {
    if (folding) return;
    if (prefersReducedMotion()) { onCollapse(); return; }
    setFolding(true);
    timer.current = window.setTimeout(onCollapse, motionDuration("slow"));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    fold();
  };
  return (
    <div className={styles.fanRow} onKeyDown={onKeyDown}>
      <div className={styles.fanFrame} data-scrolling={snap.scrolling || undefined}>
        <ScrollArea orientation="x" scrollRef={snap.ref} dataSlot="stack-deck-fan">
          <Stack align="row" gap="sm" role="list">
            {items.map((item, index) => (
              <div key={item.id} role="listitem" className={styles.fan} data-i={Math.min(index, MAX_FAN_INDEX)}
                data-folding={folding || undefined} data-stack-deck-card="">
                <StackDeckCard running={Boolean(item.running)} listeners={cardListeners?.(item)}
                  toggle={interactive ? { label: labels.fold(item.label), expanded: true, onToggle: fold, focusTarget: index === 0 } : null}>
                  {renderCard(item, { index, count: items.length, expanded: true, interactive: true })}
                </StackDeckCard>
              </div>
            ))}
          </Stack>
        </ScrollArea>
      </div>
      {folding || snap.scrolling ? null : (
        <>
          <RowEdges count={snap.hidden.start} side="start" />
          <RowEdges count={snap.hidden.end} side="end" />
        </>
      )}
    </div>
  );
}
