import type { ReactNode } from "react";
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

/**
 * Titled settings card. The title is one step above field labels (H4 vs the
 * medium body-size Label) and sits `--settings-section-header-gap` above the
 * first field, closer than fields sit to each other.
 */
export function FormSection({
  title,
  description,
  children,
  className,
}: FormSectionProps) {
  return (
    <section className={cn(styles.section, className)}>
      <div className={styles.header}>
        <Typo.H4 as="h3" className={styles.title}>{title}</Typo.H4>
        {description && (
          <Typo.Body className={styles.description}>{description}</Typo.Body>
        )}
      </div>
      <div className={styles.fields}>
        {children}
      </div>
    </section>
  );
}
