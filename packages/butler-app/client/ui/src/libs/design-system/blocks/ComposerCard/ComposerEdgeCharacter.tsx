import styles from "./ComposerDecoration.module.css";

export type ComposerEdgeCharacterKind = "crab";

/** The head: its height and how much of it the card covers (px). */
const HEAD = { height: 34, tuck: 8 };
/** Px an edge character rises above the card's top edge (`ComposerCardEdge.reserveTop`). */
export const COMPOSER_EDGE_CHARACTER_RISE = HEAD.height - HEAD.tuck;

export interface ComposerEdgeCharacterProps {
  kind: ComposerEdgeCharacterKind;
  /** `behind` (ComposerCard `edge.behind`): eyes and shell, the card hides the lower 8px; `front` (`edge.front`): claws on the top edge. */
  part: "behind" | "front";
}

/** A small character peeking over the composer card's top edge. Decorative: aria-hidden, no pointer events. */
export function ComposerEdgeCharacter({ kind, part }: ComposerEdgeCharacterProps) {
  if (part === "behind") {
    return (
      <div aria-hidden="true" className={styles.head} data-character={kind} style={{ height: HEAD.height, bottom: -HEAD.tuck }}>
        <svg focusable="false" viewBox="0 0 44 34">
          <path className={styles.stalk} d="M17 30 L15 12 M27 30 L29 12" />
          <circle className={styles.eyeWhite} cx="15" cy="10" r="3.6" />
          <circle className={styles.eyeWhite} cx="29" cy="10" r="3.6" />
          <circle className={styles.eye} cx="15.6" cy="10.4" r="1.6" />
          <circle className={styles.eye} cx="28.4" cy="10.4" r="1.6" />
          <ellipse className={styles.shell} cx="22" cy="30" rx="16" ry="9.5" />
          <ellipse className={styles.shellSpot} cx="17" cy="24.5" rx="1.4" ry="1" />
          <ellipse className={styles.shellSpot} cx="27" cy="24.5" rx="1.4" ry="1" />
        </svg>
      </div>
    );
  }
  return (
    <div aria-hidden="true" className={styles.paws} data-character={kind}>
      <svg focusable="false" viewBox="0 0 44 10">
        <path className={styles.shell} d="M5 8 C3 3 8 0.5 11 3 L9 5 L12 6 C11 8.5 7 9.5 5 8 Z" />
        <path className={styles.shell} d="M39 8 C41 3 36 0.5 33 3 L35 5 L32 6 C33 8.5 37 9.5 39 8 Z" />
      </svg>
    </div>
  );
}
