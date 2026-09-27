import styles from "./Kbd.module.css";

export interface KbdProps {
  /** Keys in press order, e.g. ["⌘", "K"] or ["Esc"]. */
  keys: string[];
  /** Spoken name when the keys are symbols, e.g. "Command K". */
  label?: string;
  size?: "sm" | "default";
}

/** A keyboard shortcut: one key cap per key inside a <kbd> combination. */
export function Kbd({ keys, label, size = "default" }: KbdProps) {
  return (
    <kbd aria-label={label} className={styles.kbd} data-size={size} data-slot="kbd">
      {keys.map((key, index) => (
        <kbd aria-hidden={label ? true : undefined} className={styles.key} key={`${key}-${index}`}>{key}</kbd>
      ))}
    </kbd>
  );
}
