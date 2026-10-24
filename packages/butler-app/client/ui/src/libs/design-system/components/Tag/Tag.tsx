import type { ReactNode } from "react";
import { Button } from "../Button";
import { X } from "../Icons";
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
  "data-test-class": dataTestClass,
}: TagProps) {
  return (
    <Stack
      align="row"
      cross="center"
      gap="xs"
      className={dsClass(styles.tag)}
      data-tone={tone}
      data-size={size}
      data-removable={onRemove ? "true" : undefined}
      data-icon-end={iconEnd && !onRemove ? "true" : undefined}
      data-test-class={dataTestClass}
      aria-label={ariaLabel}
    >
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      <Typo.Caption className={dsClass(styles.label)} wrap="nowrap">{children}</Typo.Caption>
      {iconEnd && !onRemove ? <span className={styles.iconEnd} data-slot="tag-icon-end">{iconEnd}</span> : null}
      {onRemove ? (
        <Button aria-label={removeLabel} className={dsClass(styles.remove)} type="button" variant="inline" onClick={onRemove}>
          <X size="xs" />
        </Button>
      ) : null}
    </Stack>
  );
}
