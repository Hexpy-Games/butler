import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import styles from "./DashboardHeader.module.css";
import { dsClass } from "../../lib/internal";

export interface DashboardHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  meta?: ReactNode;
}

export function DashboardHeader({
  title,
  description,
  action,
  meta,
}: DashboardHeaderProps) {
  return (
    <header className={styles.header}>
      <Stack gap="sm" className={dsClass(styles.copy)}>
        <Typo.DashboardTitle className={dsClass(styles.title)}>{title}</Typo.DashboardTitle>
        {description ? <Typo.Body className={dsClass(styles.description)}>{description}</Typo.Body> : null}
        {meta ? <Typo.Caption className={dsClass(styles.meta)}>{meta}</Typo.Caption> : null}
      </Stack>
      {action ? <div className={styles.action}>{action}</div> : null}
    </header>
  );
}
