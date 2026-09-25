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
 * Titled settings card. The header block (H4 title + 13px secondary
 * description, max 60ch) is closed by a hairline and sits
 * `--settings-section-header-gap` above the first field. Hierarchy: title
 * (18) > field label (14 medium) > section description (13) > field
 * description (12).
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
