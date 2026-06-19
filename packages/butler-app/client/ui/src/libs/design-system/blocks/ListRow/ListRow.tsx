import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./ListRow.module.css";

export interface ListRowProps {
  /** Icon element */
  icon?: ReactNode;
  /** Row title */
  title: string;
  /** Optional description */
  description?: ReactNode;
  /** Optional metadata (date, size, etc.) */
  meta?: ReactNode;
  /** Additional CSS class */
  className?: string;
}

export function ListRow({
  icon,
  title,
  description,
  meta,
  className,
}: ListRowProps) {
  return (
    <div className={cn(styles.row, className)}>
      {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
      <Stack gap="xs" className={styles.content}>
        <Stack align="row" justify="between" cross="center">
          <Typo.Body className={styles.title}>{title}</Typo.Body>
          {meta && <Typo.Caption className={styles.meta}>{meta}</Typo.Caption>}
        </Stack>
        {description && (
          <Typo.Caption className={styles.description}>{description}</Typo.Caption>
        )}
      </Stack>
    </div>
  );
}
