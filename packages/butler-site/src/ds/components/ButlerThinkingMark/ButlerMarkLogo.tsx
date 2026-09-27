import styles from "./ButlerThinkingMark.module.css";

/**
 * The filled Butler logo as SVG (the idle mark's exact geometry: two rounded
 * ribbon sectors and the ring, 1200 design units; see thinking-mark/constants.ts).
 */
export function ButlerMarkLogo() {
  return (
    <svg aria-hidden="true" className={styles.fallback} focusable="false" viewBox="0 0 1200 1200">
      <path
        d="M600 600 L300 464 A329.43 329.43 0 0 0 300 736 Z M600 600 L900 464 A329.43 329.43 0 0 1 900 736 Z"
        strokeLinejoin="round"
        strokeWidth={68}
      />
      <circle cx={600} cy={600} fill="none" r={435} strokeWidth={74} />
    </svg>
  );
}
