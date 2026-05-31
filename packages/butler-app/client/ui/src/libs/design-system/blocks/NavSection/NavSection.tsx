import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./NavSection.module.css";

export interface NavSectionProps {
  /** Section title */
  title: string;
  /** Action buttons to display in header */
  actions?: ReactNode;
  /** Navigation items to display in section */
  children: ReactNode;
  /** Additional CSS class */
  className?: string;
  /** Whether section content is hidden while preserving the header */
  collapsed?: boolean;
}

export function NavSection({
  title,
  actions,
  children,
  className,
  collapsed = false,
}: NavSectionProps) {
  return (
    <Stack
      as="section"
      align="column"
      gap="sm"
      className={cn(styles.section, className)}
    >
      <Stack
        align="row"
        justify="between"
        cross="center"
        className={styles.header}
      >
        <Typo.SectionTitle className={styles.title}>{title}</Typo.SectionTitle>
        {actions && (
          <Stack align="row" gap="xs" cross="center" className={styles.actions}>
            {actions}
          </Stack>
        )}
      </Stack>
      <div
        className={cn(styles.content, collapsed && styles.contentCollapsed)}
        aria-hidden={collapsed}
      >
        <div className={styles.contentInner}>
          <Stack align="column" gap="1">
            {children}
          </Stack>
        </div>
      </div>
    </Stack>
  );
}
