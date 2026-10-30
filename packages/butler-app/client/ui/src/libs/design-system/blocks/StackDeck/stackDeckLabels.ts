/** Accessible names of a StackDeck. The product container passes localized labels. */
export interface StackDeckLabels {
  /** The collapsed deck (a button that opens the cards into a column): `count` cards, `front` the first one's name. */
  expand: (count: number, front: string) => string;
  /** A card of the open column (a button that stacks the cards again). */
  fold: (item: string) => string;
}

/** English defaults. */
export const STACK_DECK_LABELS: StackDeckLabels = {
  expand: (count, front) => `${front} and ${count - 1} more. Show all.`,
  fold: (item) => `${item}. Stack the cards.`,
};
