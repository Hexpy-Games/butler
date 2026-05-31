import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./FormSection.module.css";

export interface FormSectionProps {
  /** Section title */
  title: string;
  /** Optional description */
  description?: string;
  /** Form rows or fields */
  children: ReactNode;
  /** Additional CSS class */
  className?: string;
}

export function FormSection({
  title,
  description,
  children,
  className,
}: FormSectionProps) {
  return (
    <Stack as="section" gap="md" className={cn(styles.section, className)}>
      <Stack gap="xs">
        <Typo.PanelTitle as="h3" className={styles.title}>{title}</Typo.PanelTitle>
        {description && (
          <Typo.Caption className={styles.description}>{description}</Typo.Caption>
        )}
      </Stack>
      <Stack gap="md" className={styles.fields}>
        {children}
      </Stack>
    </Stack>
  );
}
