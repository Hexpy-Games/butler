import { useId, type ReactNode } from "react";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./FormSection.module.css";

export interface FormSectionProps {
  /**
   * Section title. Omit it only when the section is the page's single card
   * and its title would repeat the page title.
   */
  title?: string;
  /** Optional description */
  description?: string;
  /** Form rows or fields */
  children: ReactNode;
  /** Additional CSS class */
  className?: string;
}

/**
 * Grouped settings section (macOS System Settings / iOS grouped lists /
 * Vercel and GitHub settings): the header (H4 title + 13px secondary
 * description, max 60ch) sits above the card, outside its surface, and the
 * bordered card holds only fields. Header -> card is
 * `--settings-section-header-gap`; card -> next header is the wider
 * `--settings-section-gap` owned by `SettingsShell`.
 */
export function FormSection({
  title,
  description,
  children,
  className,
}: FormSectionProps) {
  const titleId = useId();
  return (
    <section
      className={cn(styles.section, className)}
      data-slot="form-section"
      aria-labelledby={title ? titleId : undefined}
    >
      {title || description ? (
        <div className={styles.header} data-slot="form-section-header">
          {title ? (
            <Typo.H4 as="h3" id={titleId} className={styles.title}>{title}</Typo.H4>
          ) : null}
          {description ? (
            <Typo.Body className={styles.description}>{description}</Typo.Body>
          ) : null}
        </div>
      ) : null}
      <div className={styles.card} data-slot="form-section-card">
        {children}
      </div>
    </section>
  );
}
