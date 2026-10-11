import styles from "./SetupWizardIntro.module.css";

export interface SetupWizardMarkProps {
  /** Accessible name; omit when the card heading names Butler already. */
  label?: string;
}

/**
 * The plain Butler logo in the 64px slot of the first-run welcome card. It
 * stays still while Butler prepares (the preparation row shows progress). The
 * ink intro glides its printed mark onto this slot and hands over to it; without
 * WebGL2 its ring draws clockwise from the top and its bow tie prints.
 */
export function SetupWizardMark({ label }: SetupWizardMarkProps) {
  return (
    <svg
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={styles.mark}
      data-setup-mark=""
      data-test-class="setup-wizard-mark"
      role={label ? "img" : undefined}
      viewBox="0 0 1200 1200"
    >
      <path
        d="M600 600L300 464A329.43 329.43 0 0 0 300 736ZM600 600L900 464A329.43 329.43 0 0 1 900 736Z"
        data-mark-bow=""
        fill="currentColor"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="68"
      />
      <circle
        cx="600"
        cy="600"
        data-mark-ring=""
        fill="none"
        pathLength={1}
        r="435"
        stroke="currentColor"
        strokeDasharray="1 1"
        strokeWidth="74"
        transform="rotate(-90 600 600)"
      />
    </svg>
  );
}
