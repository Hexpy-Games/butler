import type { DecorationTheme } from "./decorationScenes";
import styles from "./ComposerDecorations.module.css";

export type CharacterKind = "cat" | "crab";

export function characterFor(theme: DecorationTheme): CharacterKind {
  return theme === "shoreline" ? "crab" : "cat";
}

/**
 * The part behind the card: rendered before ComposerCard, so the card paints over its lower
 * 8px and the character looks like it is peeking over the top edge. Decorative only.
 */
export function CharacterHead({ kind }: { kind: CharacterKind }) {
  return (
    <div aria-hidden="true" className={styles.head} data-character={kind}>
      <svg viewBox="0 0 44 34" focusable="false">
        {kind === "cat" ? (
          <g>
            <path className={styles.fur} d="M7 3 L4 17 L17 11 Z M37 3 L40 17 L27 11 Z" />
            <path className={styles.inner} d="M8 7 L6.5 14 L13 11 Z M36 7 L37.5 14 L31 11 Z" />
            <ellipse className={styles.fur} cx="22" cy="21" rx="16" ry="12.5" />
            <ellipse className={styles.blush} cx="12.5" cy="23" rx="2.6" ry="1.4" />
            <ellipse className={styles.blush} cx="31.5" cy="23" rx="2.6" ry="1.4" />
            <ellipse className={styles.eye} cx="16.5" cy="18.5" rx="1.6" ry="2.1" />
            <ellipse className={styles.eye} cx="27.5" cy="18.5" rx="1.6" ry="2.1" />
            <path className={styles.inner} d="M20.6 22 h2.8 l-1.4 1.6 Z" />
          </g>
        ) : (
          <g>
            <path className={styles.stalk} d="M17 30 L15 12 M27 30 L29 12" />
            <circle className={styles.eyeWhite} cx="15" cy="10" r="3.6" />
            <circle className={styles.eyeWhite} cx="29" cy="10" r="3.6" />
            <circle className={styles.eye} cx="15.6" cy="10.4" r="1.6" />
            <circle className={styles.eye} cx="28.4" cy="10.4" r="1.6" />
            <ellipse className={styles.shell} cx="22" cy="30" rx="16" ry="9.5" />
            <ellipse className={styles.shellSpot} cx="17" cy="24.5" rx="1.4" ry="1" />
            <ellipse className={styles.shellSpot} cx="27" cy="24.5" rx="1.4" ry="1" />
          </g>
        )}
      </svg>
    </div>
  );
}

/** The part in front of the card: paws (or claws) resting on the top edge, inside its padding. */
export function CharacterPaws({ kind }: { kind: CharacterKind }) {
  return (
    <div aria-hidden="true" className={styles.paws} data-character={kind}>
      <svg viewBox="0 0 44 10" focusable="false">
        {kind === "cat" ? (
          <g>
            <ellipse className={styles.fur} cx="13" cy="5" rx="4.6" ry="3.6" />
            <ellipse className={styles.fur} cx="31" cy="5" rx="4.6" ry="3.6" />
            <path className={styles.toe} d="M11.5 6.5 v1.6 M14.5 6.5 v1.6 M29.5 6.5 v1.6 M32.5 6.5 v1.6" />
          </g>
        ) : (
          <g>
            <path className={styles.shell} d="M5 8 C3 3 8 0.5 11 3 L9 5 L12 6 C11 8.5 7 9.5 5 8 Z" />
            <path className={styles.shell} d="M39 8 C41 3 36 0.5 33 3 L35 5 L32 6 C33 8.5 37 9.5 39 8 Z" />
          </g>
        )}
      </svg>
    </div>
  );
}
