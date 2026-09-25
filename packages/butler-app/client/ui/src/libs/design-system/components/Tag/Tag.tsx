import type { ReactNode } from "react";
import { Button } from "../Button";
import { X } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import styles from "./Tag.module.css";

export type TagTone = "neutral" | "accent" | "success" | "warning" | "danger";

export interface TagProps {
  children: ReactNode;
  /** Leading icon; sized to --icon-size-xs. */
  icon?: ReactNode;
  tone?: TagTone;
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
  tone = "neutral",
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
      className={styles.tag}
      data-tone={tone}
      data-test-class={dataTestClass}
      aria-label={ariaLabel}
    >
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      <Typo.Caption className={styles.label} wrap="nowrap">{children}</Typo.Caption>
      {onRemove ? (
        <Button aria-label={removeLabel} className={styles.remove} type="button" variant="inline" onClick={onRemove}>
          <X size="xs" />
        </Button>
      ) : null}
    </Stack>
  );
}
