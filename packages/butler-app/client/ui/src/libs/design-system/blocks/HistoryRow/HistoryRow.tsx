import type { ReactNode } from "react";
import { Clickable } from "../../components/Clickable";
import { CheckIcon } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { SiteIcon } from "../../lib/SiteIcon";
import { cn } from "../../lib/utils";
import { splitAddress } from "../AddressField/splitAddress";
import styles from "./HistoryRow.module.css";

export interface HistoryRowProps extends DsPrivateStyleProps {
  /** Page title; empty (or the URL itself) shows the host and path once. */
  title?: string;
  /** Full URL; the row shows its host after the title. */
  url: string;
  /** Favicon URL; a missing or broken icon shows a globe. */
  iconSrc?: string;
  /** Visit time, formatted for the locale ("8:27 PM", "오후 8:27"); right-aligned in tabular figures. */
  time: string;
  /** Machine-readable visit time for the time element. */
  dateTime?: string;
  /** Opens the page: a click or Enter on the row. */
  onOpen: () => void;
  /** Row actions (IconButtons in a ButtonContainer size="icon-sm") that take the time column on hover or keyboard focus. */
  actions?: ReactNode;
  /** Selection mode: the row is a checkbox (click toggles), with a leading check box; actions hide. */
  selecting?: boolean;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  /** Stable id exposed as data-row-id for tests and drag sources. */
  rowId?: string | number;
}

/**
 * One visit in a history list, on one dense line: favicon, title, muted host, and the time at the
 * end. Hover or keyboard focus swaps the time for the row actions; selection mode adds a check box.
 */
export function HistoryRow({
  title, url, iconSrc, time, dateTime, onOpen, actions, selecting = false, selected = false, onSelectedChange, rowId, className,
}: HistoryRowProps) {
  const { host: urlHost, path } = splitAddress(url);
  const host = urlHost || url;
  // A page without a title records its URL as the title; show the address once.
  const named = Boolean(title) && title !== url;
  const label = named ? title! : `${host}${path}`;
  const showActions = Boolean(actions) && !selecting;
  return (
    <div className={cn(styles.row, className)} data-slot="history-row" data-row-id={rowId} data-selecting={selecting || undefined}
      data-selected={(selecting && selected) || undefined} data-has-actions={showActions || undefined}>
      <Clickable className={dsClass(styles.main)} stretch title={url} role={selecting ? "checkbox" : "button"}
        aria-checked={selecting ? selected : undefined} aria-label={selecting ? label : `${label}, ${host}`}
        onClick={selecting ? () => onSelectedChange?.(!selected) : onOpen}>
        <span className={styles.lead}>
          {selecting ? <span className={styles.check} aria-hidden="true">{selected ? <CheckIcon size="xs" /> : null}</span> : null}
          <SiteIcon src={iconSrc} />
          <span className={styles.text}>
            <span className={styles.title}>{label}</span>
            {named ? <span className={styles.host}>{host}</span> : null}
          </span>
        </span>
      </Clickable>
      <span className={styles.trail}>
        <Typo.Caption className={dsClass(styles.time)} as="time" dateTime={dateTime} tone="tertiary" numeric="tabular">{time}</Typo.Caption>
        {showActions ? <span className={styles.actions}>{actions}</span> : null}
      </span>
    </div>
  );
}

export interface HistoryGroupProps extends DsPrivateStyleProps {
  /** The day ("Today - Sunday, October 11"), formatted for the locale. */
  title: string;
  /** HistoryRow items, newest first. */
  children: ReactNode;
}

/** A day of visits: a quiet heading over dense rows. */
export function HistoryGroup({ title, children, className }: HistoryGroupProps) {
  return (
    <section className={cn(styles.group, className)} aria-label={title} data-slot="history-group">
      <Typo.Label className={dsClass(styles.heading)} as="h3" weight="semibold" tone="secondary">{title}</Typo.Label>
      <div className={styles.rows}>{children}</div>
    </section>
  );
}
