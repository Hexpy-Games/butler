import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { NavSectionHeading } from "./NavSectionHeading";
import { Collapsible } from "../../components/Collapsible";
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
      <NavSectionHeading title={title} actions={actions} />
      <Collapsible open={!collapsed} keepMounted className={styles.content} aria-hidden={collapsed}>
        <Stack align="column" gap="xs">
          {children}
        </Stack>
      </Collapsible>
    </Stack>
  );
}
