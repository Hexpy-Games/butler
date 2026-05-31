import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./ResourceSummary.module.css";

export interface ResourceSummaryProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  className?: string;
}

export function ResourceSummary({
  icon,
  title,
  description,
  meta,
  className,
}: ResourceSummaryProps) {
  return (
    <Stack gap="sm" className={cn(styles.summary, className)}>
      {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
      <Stack gap="xs" className={styles.body}>
        <Typo.Body className={styles.title}>{title}</Typo.Body>
        {description && (
          <Typo.Caption className={styles.description}>{description}</Typo.Caption>
        )}
        {meta && (
          <Typo.Caption className={styles.meta}>{meta}</Typo.Caption>
        )}
      </Stack>
    </Stack>
  );
}
