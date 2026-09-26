import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { NavSectionHeading } from "./NavSectionHeading";
import { Collapsible } from "../../components/Collapsible";
import styles from "./NavSection.module.css";
import { dsClass } from "../../lib/internal";

export interface NavSectionProps extends DsPrivateStyleProps {
  /** Section title */
  title: string;
  /** Action buttons to display in header */
  actions?: ReactNode;
  /** Navigation items to display in section */
  children: ReactNode;
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
      className={dsClass(styles.section, className)}
    >
      <NavSectionHeading title={title} actions={actions} />
      <Collapsible open={!collapsed} keepMounted className={dsClass(styles.content)} aria-hidden={collapsed}>
        <Stack align="column" gap="xs">
          {children}
        </Stack>
      </Collapsible>
    </Stack>
  );
}
