import styles from "./CheckCard.module.css";

/** CheckIcon's geometry (Hugeicons 24 grid), drawn as a stroke so it can draw in. */
const CHECK_PATH = "M5 14L8.5 17.5L19 6.5";

/**
 * The round check indicator: a ring on the card surface. Checked fills it with the accent from the centre
 * and draws the check; both stay mounted so a toggle mid-animation reverses cleanly. Shared by CheckCard
 * and the read-only CheckList.
 */
export function CheckIndicator({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden="true" className={styles.indicator} data-checked={checked ? "true" : undefined}>
      <span className={styles.fill} />
      <svg className={styles.mark} viewBox="0 0 24 24" fill="none" focusable="false">
        <path d={CHECK_PATH} pathLength={1} stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
