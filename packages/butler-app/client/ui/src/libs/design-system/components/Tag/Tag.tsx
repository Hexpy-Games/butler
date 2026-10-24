import type { ReactNode } from "react";
import { Button } from "../Button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../DropdownMenu";
import { Pencil, X } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import styles from "./Tag.module.css";
import { dsClass } from "../../lib/internal";
import type { TagLabelTone } from "./tagTones";

export { tagLabelTones, type TagLabelTone } from "./tagTones";
/** Status tones (`neutral` … `danger`) or a categorical label tone (`gray` … `purple`). */
export type TagTone = "neutral" | "accent" | "success" | "warning" | "danger" | TagLabelTone;
/** `sm`: inline status and filter chips. `md`: page eyebrows and hero labels. */
export type TagSize = "sm" | "md";

export interface TagProps {
  children: ReactNode;
  /** Leading icon; sized to --icon-size-xs. */
  icon?: ReactNode;
  /**
   * Trailing icon, sized to --icon-size-xs: a chevron when the Tag is the
   * visible cue of a larger target that opens more ("+4 ›"). The Tag itself
   * stays non-interactive; the surrounding control acts.
   */
  iconEnd?: ReactNode;
  tone?: TagTone;
  size?: TagSize;
  ariaLabel?: string;
  /** Renders a trailing remove button inside the pill. */
  onRemove?: () => void;
  /** Accessible name of the remove button; required with onRemove. */
  removeLabel?: string;
  /**
   * DropdownMenuItems opened by a trailing pencil button placed before
   * remove: rename, recolor or delete the label itself. Only where the label
   * is editable; read-only views leave it out.
   */
  editMenu?: ReactNode;
  /** Accessible name of the edit button; required with editMenu. */
  editLabel?: string;
  "data-test-class"?: string;
}

export function Tag({
  children,
  icon,
  iconEnd,
  tone = "neutral",
  size = "sm",
  ariaLabel,
  onRemove,
  removeLabel,
  editMenu,
  editLabel,
  "data-test-class": dataTestClass,
}: TagProps) {
  const trailingIcon = iconEnd && !onRemove && !editMenu;
  return (
    <Stack
      align="row"
      cross="center"
      gap="xs"
      className={dsClass(styles.tag)}
      data-tone={tone}
      data-size={size}
      data-removable={onRemove ? "true" : undefined}
      data-editable={editMenu ? "true" : undefined}
      data-icon-end={trailingIcon ? "true" : undefined}
      data-test-class={dataTestClass}
      aria-label={ariaLabel}
    >
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      <Typo.Caption className={dsClass(styles.label)} wrap="nowrap">{children}</Typo.Caption>
      {trailingIcon ? <span className={styles.iconEnd} data-slot="tag-icon-end">{iconEnd}</span> : null}
      {editMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button aria-label={editLabel} className={dsClass(styles.action)} type="button" variant="inline">
              <Pencil size="xs" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={8}>{editMenu}</DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {onRemove ? (
        <Button aria-label={removeLabel} className={dsClass(styles.action)} type="button" variant="inline" onClick={onRemove}>
          <X size="xs" />
        </Button>
      ) : null}
    </Stack>
  );
}
