import type { ReactNode } from "react";
import { Section } from "../../components/Section";
import { Stack } from "../../components/Stack";
import { cn } from "../../lib/utils";
import styles from "./InspectorPanel.module.css";

export interface InspectorPanelProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function InspectorPanel({
  title,
  description,
  icon,
  action,
  children,
  className,
}: InspectorPanelProps) {
  return (
    <Section
      className={cn(styles.panel, className)}
      title={title}
      description={description}
      icon={icon}
      actions={action}
      gap="sm"
    >
      <Stack gap="sm">{children}</Stack>
    </Section>
  );
}
