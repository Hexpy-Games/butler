import { useId, type ReactNode } from "react";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import { repeatsSettingsCopy, useSettingsPage } from "../SettingsShell/settingsPage";
import styles from "./FormSection.module.css";

export interface FormSectionProps {
  /**
   * Section title. Omit it when it would repeat the page title; inside a
   * `SettingsShell` page a title that repeats `pageTitle` is not rendered.
   */
  title?: string;
  /** Optional description; inside a `SettingsShell` page one that repeats `pageDescription` is not rendered. */
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
 * `--settings-section-gap` owned by `SettingsShell`. Copy that repeats the
 * page header (see `repeatsSettingsCopy`) is dropped, so a page whose single
 * section only restates the page renders the card alone.
 */
export function FormSection({
  title,
  description,
  children,
  className,
}: FormSectionProps) {
  const titleId = useId();
  const page = useSettingsPage();
  const shownTitle = title && !repeatsSettingsCopy(title, page?.title) ? title : undefined;
  const shownDescription =
    description && !repeatsSettingsCopy(description, page?.description) ? description : undefined;
  return (
    <section
      className={cn(styles.section, className)}
      data-slot="form-section"
      aria-labelledby={shownTitle ? titleId : undefined}
    >
      {shownTitle || shownDescription ? (
        <div className={styles.header} data-slot="form-section-header">
          {shownTitle ? (
            <Typo.H4 as="h3" id={titleId} className={styles.title}>{shownTitle}</Typo.H4>
          ) : null}
          {shownDescription ? (
            <Typo.Body className={styles.description}>{shownDescription}</Typo.Body>
          ) : null}
        </div>
      ) : null}
      <div className={styles.card} data-slot="form-section-card">
        {children}
      </div>
    </section>
  );
}
