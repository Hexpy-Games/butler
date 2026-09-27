import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./ListRow.module.css";
import { dsClass } from "../../lib/internal";

export interface ListRowProps extends DsPrivateStyleProps {
  /** Icon element */
  icon?: ReactNode;
  /** Row title */
  title: string;
  /** Optional description */
  description?: string;
  /** Optional metadata (date, size, etc.) */
  meta?: string;
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
      <Stack gap="xs" className={dsClass(styles.content)}>
        <Stack align="row" justify="between" cross="center">
          <Typo.Body className={dsClass(styles.title)}>{title}</Typo.Body>
          {meta && <Typo.Caption className={dsClass(styles.meta)}>{meta}</Typo.Caption>}
        </Stack>
        {description && (
          <Typo.Caption className={dsClass(styles.description)}>{description}</Typo.Caption>
        )}
      </Stack>
    </div>
  );
}
