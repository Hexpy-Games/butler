import type { ReactNode } from "react";
import { Clickable } from "../../components/Clickable";
import { Typo } from "../../components/Typo";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import styles from "./VersionHistory.module.css";

export interface VersionHistoryEntry {
  id: string;
  /** Who made it: the person (나) or Butler (버틀러). Butler rows take the Butler ink mark. */
  author: "user" | "butler";
  /** The author's name as shown: "나", "버틀러". */
  authorLabel: string;
  /** When, formatted for the locale ("오후 3:12", "어제"). */
  time: string;
  /** Machine-readable time for the time element. */
  dateTime?: string;
}

export interface VersionHistoryProps extends DsPrivateStyleProps {
  /** Newest first; the first entry is the current version. */
  entries: VersionHistoryEntry[];
  /** The version being previewed. */
  selectedId?: string;
  onSelect: (id: string) => void;
  /** Names the list for assistive tech. */
  label: string;
  /** The word on the current version's row ("현재"). */
  currentLabel: string;
  /** The footer action for the selected version (Restore), absent while the current version is selected. */
  action?: ReactNode;
}

/**
 * A document's version history: one row per version, newest first, each with who made it (나 or 버틀러)
 * and when. Picking a row previews that version; the footer action restores it. Opened in a Popover, it
 * spans the screen under its trigger on a phone (the popover sheet).
 */
export function VersionHistory({ entries, selectedId, onSelect, label, currentLabel, action, className }: VersionHistoryProps) {
  return (
    <div className={dsClass(styles.history, className)} data-slot="version-history">
      <ul aria-label={label} className={styles.list} role="listbox">
        {entries.map((entry, index) => (
          <li key={entry.id} aria-selected={entry.id === selectedId} role="option">
            <Clickable className={dsClass(styles.row)} data-author={entry.author} data-selected={entry.id === selectedId ? "true" : undefined}
              variant="text" onClick={() => onSelect(entry.id)}>
              <span aria-hidden="true" className={styles.mark} data-author={entry.author} />
              <Typo.Label as="span" truncate weight={entry.author === "butler" ? "semibold" : undefined}>{entry.authorLabel}</Typo.Label>
              {index === 0 ? <Typo.Caption as="span" tone="secondary">{currentLabel}</Typo.Caption> : null}
              <Typo.Caption as="time" className={dsClass(styles.time)} dateTime={entry.dateTime} numeric="tabular" tone="tertiary">{entry.time}</Typo.Caption>
            </Clickable>
          </li>
        ))}
      </ul>
      {action ? <div className={styles.footer}>{action}</div> : null}
    </div>
  );
}
