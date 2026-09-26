import { useId, type ReactNode } from "react";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import { SettingsFieldScopeProvider } from "../SettingsField/settingsFieldScope";
import { repeatsSettingsCopy, useSettingsPage } from "../SettingsShell/settingsPage";
import styles from "./FormSection.module.css";

export type FormSectionKind = "form" | "list" | "status" | "info";

export interface FormSectionProps {
  /**
   * Section title. Omit it when it would repeat the page title; inside a
   * `SettingsShell` page a title that repeats `pageTitle` is not rendered.
   */
  title?: string;
  /** Optional description; inside a `SettingsShell` page one that repeats `pageDescription` is not rendered. */
  description?: string;
  /** Header toolbar, at the inline end of the title and description (wraps under them when narrow). */
  actions?: ReactNode;
  /** Card rhythm: `form` keeps the field ramp; `list`, `status` and `info` use the tighter row gap. */
  kind?: FormSectionKind;
  /** Stable section id (`data-settings-section-id`), scoped to the fields inside. */
  sectionId?: string;
  /** Marks the card busy while its content loads. */
  busy?: boolean;
  /** Form rows or fields */
  children: ReactNode;
  /** Additional CSS class */
  className?: string;
}

/**
 * Grouped settings section (macOS System Settings / iOS grouped lists /
 * Vercel and GitHub settings): the header (H4 title + 13px secondary
 * description, max 60ch, optional toolbar) sits above the card, outside its
 * surface, and the bordered card is the section's only surface.
 * Header -> card is `--settings-section-header-gap`; card -> next header is
 * the wider `--settings-section-gap` owned by the page. Copy that repeats the
 * page header (see `repeatsSettingsCopy`) is dropped, so a page whose single
 * section only restates the page renders the card alone.
 */
export function FormSection({
  title,
  description,
  actions,
  kind = "form",
  sectionId,
  busy,
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
      data-settings-section-id={sectionId}
      data-kind={kind}
      aria-labelledby={shownTitle ? titleId : undefined}
      aria-busy={busy || undefined}
    >
      {shownTitle || shownDescription || actions ? (
        <div className={styles.header} data-slot="form-section-header">
          {shownTitle || shownDescription ? (
            <div className={styles.copy}>
              {shownTitle ? (
                <Typo.H4 as="h3" id={titleId} className={styles.title}>{shownTitle}</Typo.H4>
              ) : null}
              {shownDescription ? (
                <Typo.Body className={styles.description}>{shownDescription}</Typo.Body>
              ) : null}
            </div>
          ) : null}
          {actions ? (
            <div className={styles.actions} data-slot="form-section-actions">{actions}</div>
          ) : null}
        </div>
      ) : null}
      <div className={styles.card} data-slot="form-section-card" data-kind={kind}>
        <SettingsFieldScopeProvider sectionId={sectionId}>{children}</SettingsFieldScopeProvider>
      </div>
    </section>
  );
}
