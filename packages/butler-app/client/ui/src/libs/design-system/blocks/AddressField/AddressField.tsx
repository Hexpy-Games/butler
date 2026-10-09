import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Clickable } from "../../components/Clickable";
import { IconButton } from "../../components/IconButton";
import { Globe2, Lock, Star, StarFilled, Warning } from "../../components/Icons";
import { Input } from "../../components/Input";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { cn } from "../../lib/utils";
import { splitAddress } from "./splitAddress";
import styles from "./AddressField.module.css";

export type AddressSecurity = "secure" | "insecure" | "internal";

export interface AddressFieldLabels {
  /** Accessible name of the field ("Address"). */
  field: string;
  placeholder: string;
  secure: string;
  insecure: string;
  bookmarkAdd: string;
  bookmarked: string;
}

const DEFAULT_LABELS: AddressFieldLabels = {
  field: "Address", placeholder: "Search or enter URL", secure: "Secure connection", insecure: "Not secure",
  bookmarkAdd: "Add bookmark", bookmarked: "Bookmarked",
};

export interface AddressFieldProps extends DsPrivateStyleProps {
  /** The page URL; shown as the bold host and the muted path, edited in full. Empty shows the placeholder. */
  url?: string;
  /** A Butler page's name (the library) in place of the host; pair it with `icon`. */
  title?: ReactNode;
  /** Replaces the security glyph (a Butler page's icon). */
  icon?: ReactNode;
  security?: AddressSecurity;
  /** Tags before the star (signed in, Butler output, preview): `Tag size="sm"`. */
  tags?: ReactNode;
  bookmarked?: boolean;
  /** Shows the star; omit for pages that cannot be bookmarked. */
  onToggleBookmark?: () => void;
  /** Enter in edit mode; omit to make the field read-only. */
  onSubmit?: (value: string) => void;
  disabled?: boolean;
  /** Controlled edit mode (Cmd+L); omit to let a click toggle it. */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  labels?: Partial<AddressFieldLabels>;
}

/**
 * The toolbar's address: security glyph, bold host with a muted path (truncating at the end), tags and
 * the bookmark star. A click (or Enter/Space) turns it into a plain text input with the full URL
 * selected; Enter submits, Escape and blur cancel.
 */
export function AddressField({
  url = "", title, icon, security = "secure", tags, bookmarked = false, onToggleBookmark, onSubmit, disabled = false,
  editing: editingProp, onEditingChange, labels: labelOverrides, className,
}: AddressFieldProps) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides };
  const [ownEditing, setOwnEditing] = useState(false);
  const editing = !disabled && Boolean(onSubmit) && (editingProp ?? ownEditing);
  const setEditing = (next: boolean) => {
    setOwnEditing(next);
    onEditingChange?.(next);
  };
  const { host, path } = splitAddress(url);
  const glyph = icon ?? (security === "insecure" ? <Warning size="md" /> : security === "internal" ? <Globe2 size="md" /> : <Lock size="md" />);
  const glyphLabel = security === "insecure" ? labels.insecure : security === "secure" && !icon ? labels.secure : undefined;
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onSubmit?.(event.currentTarget.value.trim());
      setEditing(false);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setEditing(false);
    }
  };
  return (
    <div className={cn(styles.field, className)} data-slot="address-field" data-editing={editing || undefined} data-disabled={disabled || undefined}>
      <span className={styles.glyph} data-security={security} role={glyphLabel ? "img" : undefined} aria-label={glyphLabel}
        aria-hidden={glyphLabel ? undefined : true}>{glyph}</span>
      {editing ? (
        <Input className={dsClass(styles.input)} aria-label={labels.field} placeholder={labels.placeholder} defaultValue={url} autoFocus
          spellCheck={false} onFocus={(event) => event.currentTarget.select()} onKeyDown={onKeyDown} onBlur={() => setEditing(false)} />
      ) : (
        <Clickable className={dsClass(styles.display)} variant="text" disabled={disabled || !onSubmit}
          aria-label={`${labels.field}: ${url || labels.placeholder}`} onClick={onSubmit ? () => setEditing(true) : undefined}>
          <span className={styles.text}>
            {title ? <span className={styles.host}>{title}</span>
              : host ? <><span className={styles.host}>{host}</span><span className={styles.path}>{path}</span></>
                : <span className={styles.placeholder}>{labels.placeholder}</span>}
          </span>
        </Clickable>
      )}
      {tags && !editing ? <span className={styles.tags}>{tags}</span> : null}
      {onToggleBookmark && !editing ? (
        <IconButton className={dsClass(styles.star)} label={bookmarked ? labels.bookmarked : labels.bookmarkAdd} pressed={bookmarked}
          onClick={onToggleBookmark} disabled={disabled}>
          {bookmarked ? <StarFilled size="md" /> : <Star size="md" />}
        </IconButton>
      ) : null}
    </div>
  );
}
