import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { ReactNode } from "react";
import { Section } from "../../components/Section";
import { Stack } from "../../components/Stack";
import styles from "./InspectorPanel.module.css";
import { dsClass } from "../../lib/internal";

export interface InspectorPanelProps extends DsPrivateStyleProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
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
      className={dsClass(styles.panel, className)}
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
