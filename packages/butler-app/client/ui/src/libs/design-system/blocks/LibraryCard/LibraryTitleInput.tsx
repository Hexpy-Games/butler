import { useRef, useState } from "react";
import styles from "./LibraryCard.module.css";

/** Renames the item in place: the title becomes a field; Enter or leaving it commits, Escape cancels. */
export interface LibraryCardEditing {
  value: string;
  /** Accessible name of the field ("Name"). */
  label: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

/** The title row as a field, all text selected on entry. Commits once (Enter, Tab or blur), Escape cancels. */
export function LibraryTitleInput({ editing }: { editing: LibraryCardEditing }) {
  const [value, setValue] = useState(editing.value);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) editing.onCommit(value.trim());
    else editing.onCancel();
  };
  return (
    <input
      className={styles.titleInput}
      aria-label={editing.label}
      value={value}
      maxLength={200}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); finish(true); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); }
      }}
    />
  );
}
