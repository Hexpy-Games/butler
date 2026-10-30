import type { ReactNode } from "react";
import { IconSlot } from "../../components/IconSlot";
import { Star, StarFilled } from "../../components/Icons";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { SiteIcon } from "../../lib/SiteIcon";
import { splitTextMatches } from "../../lib/textMatch";
import { cn } from "../../lib/utils";
import { splitAddress } from "../AddressField/splitAddress";
import styles from "./SuggestionList.module.css";

export interface SuggestionListProps extends DsPrivateStyleProps {
  /** The listbox id; the field that owns the list points at it (AddressField listbox.id). */
  id: string;
  /** Accessible name of the list ("Address suggestions"). */
  label: string;
  /** SuggestionRow options, best match first. */
  children: ReactNode;
}

/** The listbox under a combobox field. Focus stays in the field; rows are options it highlights. */
export function SuggestionList({ id, label, children, className }: SuggestionListProps) {
  return (
    <div id={id} role="listbox" aria-label={label} className={cn(styles.list, className)} data-slot="suggestion-list">
      {children}
    </div>
  );
}

/** Where a suggestion comes from; a bookmark carries a star badge and a star fallback glyph. */
export type SuggestionKind = "history" | "bookmark";

export interface SuggestionRowProps extends DsPrivateStyleProps {
  /** Option id; the field sets it as aria-activedescendant while the row is highlighted. */
  id: string;
  /** Page title; empty (or the URL itself) shows the address alone. */
  title?: string;
  /** Full URL; shown without the scheme after the title. */
  url: string;
  /** Favicon URL; a missing or broken icon shows the kind glyph. */
  iconSrc?: string;
  kind?: SuggestionKind;
  /** Accessible name of the bookmark badge ("Bookmarked"). */
  bookmarkLabel?: string;
  /** The typed text; its terms are bold in the title and address. */
  query?: string;
  /** Keyboard highlight (aria-selected). */
  active?: boolean;
  onSelect: () => void;
}

function Matched({ text, query }: { text: string; query?: string }) {
  return splitTextMatches(text, query ?? "").map((part, index) =>
    part.match ? <mark key={index} className={styles.term}>{part.text}</mark> : part.text);
}

/**
 * One address suggestion on one line: favicon, title, then the muted host and path, with the typed
 * terms in bold and a star for bookmarks. Pointer down keeps focus in the field; click chooses.
 */
export function SuggestionRow({
  id, title, url, iconSrc, kind = "history", bookmarkLabel = "Bookmarked", query, active = false, onSelect, className,
}: SuggestionRowProps) {
  const { host, path } = splitAddress(url);
  const address = host ? `${host}${path}` : url;
  // A page without a title records its URL as the title; show the address once.
  const named = Boolean(title) && title !== url;
  return (
    <div id={id} role="option" aria-selected={active} data-active={active || undefined} data-kind={kind}
      className={cn(styles.row, className)} onPointerDown={(event) => event.preventDefault()} onClick={onSelect}>
      <SiteIcon src={iconSrc} fallback={kind === "bookmark" ? <Star size="md" /> : undefined} />
      <span className={styles.text}>
        <span className={styles.title}><Matched text={named ? title! : address} query={query} /></span>
        {named ? <span className={styles.address}><Matched text={address} query={query} /></span> : null}
      </span>
      {kind === "bookmark" ? <span className={styles.badge} role="img" aria-label={bookmarkLabel}><StarFilled size="sm" /></span> : null}
    </div>
  );
}

export interface SuggestionItemRowProps extends DsPrivateStyleProps {
  /** Option id; the field sets it as aria-activedescendant while the row is highlighted. */
  id: string;
  /** The item's type glyph: a DS icon at size md, in the 16px favicon column. */
  icon: ReactNode;
  title: string;
  /** Muted text after the title (where the item lives, or its type); truncates first. */
  meta?: string;
  /** The meta is a field the query searches (a project name), so its matches are bold too. Leave it
   * off for a type label ("Project"), which never matches. */
  matchMeta?: boolean;
  /** The typed text; its terms are bold in the title (and in the meta with `matchMeta`). */
  query?: string;
  /** Keyboard highlight (aria-selected). */
  active?: boolean;
  onSelect: () => void;
}

/**
 * One app item on one line: a type glyph, the title and muted meta, with the typed terms in bold.
 * Same height, highlight and pointer behaviour as SuggestionRow, for app items instead of addresses.
 */
export function SuggestionItemRow({ id, icon, title, meta, matchMeta = false, query, active = false, onSelect, className }: SuggestionItemRowProps) {
  return (
    <div id={id} role="option" aria-selected={active} data-active={active || undefined} data-kind="item"
      className={cn(styles.row, className)} onPointerDown={(event) => event.preventDefault()} onClick={onSelect}>
      <IconSlot size="md" tone="secondary" aria-hidden="true">{icon}</IconSlot>
      <span className={styles.text}>
        <span className={styles.title}><Matched text={title} query={query} /></span>
        {meta ? <span className={styles.address}><Matched text={meta} query={matchMeta ? query : undefined} /></span> : null}
      </span>
    </div>
  );
}
