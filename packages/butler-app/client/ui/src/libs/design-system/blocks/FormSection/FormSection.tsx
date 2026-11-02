import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { useId, type ReactNode } from "react";
import { Typo } from "../../components/Typo";
import { isDevBuild } from "../../lib/devBuild";
import { cn } from "../../lib/utils";
import { SettingsFieldScopeProvider } from "../SettingsField/settingsFieldScope";
import { repeatsSettingsCopy, useSettingsPage } from "../SettingsShell/settingsPage";
import styles from "./FormSection.module.css";
import { dsClass } from "../../lib/internal";

export type FormSectionKind = "form" | "list" | "status" | "info";

export interface FormSectionProps extends DsPrivateStyleProps {
  /**
   * Section title; every section has one. It names this card below the page
   * title, so it never repeats `pageTitle` (a repeat throws in dev builds).
   */
  title: string;
  /** Optional description; inside a `SettingsShell` page one that repeats `pageDescription` is not rendered. */
  description?: string;
  /**
   * Section actions (add, refresh, filter, period) at the inline end of the
   * header, outline and small; only on `kind="list"` and `kind="status"`.
   * Never a setting: settings are fields in the card, and reset, clear or
   * export are `SettingsActionField` rows.
   */
  actions?: ReactNode;
  /**
   * Card rhythm: `form` keeps the field gap; `list`, `status` and `info` use
   * the tighter row gap, except that a card holding a field always uses the
   * field gap.
   */
  kind?: FormSectionKind;
  /** Stable section id (`data-settings-section-id`), scoped to the fields inside. */
  sectionId?: string;
  /** Marks the card busy while its content loads. */
  busy?: boolean;
  /** Form rows or fields */
  children: ReactNode;
}

/**
 * Grouped settings section (macOS System Settings / iOS grouped lists /
 * Vercel and GitHub settings): the header (H4 title + 13px secondary
 * description, max 60ch, optional toolbar) sits above the card, outside its
 * surface, and the bordered card is the section's only surface.
 * Header -> card is `--settings-section-header-gap`; card -> next header is
 * the wider `--settings-section-gap` owned by the page. A title that repeats
 * the page title (see `repeatsSettingsCopy`) throws in dev builds; a
 * description that repeats the page description is dropped.
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
  if (isDevBuild() && repeatsSettingsCopy(title, page?.title)) {
    throw new Error(`Settings section title "${title}" repeats the page title; name what this card holds.`);
  }
  const shownDescription =
    description && !repeatsSettingsCopy(description, page?.description) ? description : undefined;
  return (
    <section
      className={cn(styles.section, className)}
      data-slot="form-section"
      data-settings-section-id={sectionId}
      data-kind={kind}
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
    >
      <div className={styles.header} data-slot="form-section-header">
        <div className={styles.copy}>
          <Typo.H4 as="h3" id={titleId} className={dsClass(styles.title)}>{title}</Typo.H4>
          {shownDescription ? (
            <Typo.Body className={dsClass(styles.description)}>{shownDescription}</Typo.Body>
          ) : null}
        </div>
        {actions ? (
          <div className={styles.actions} data-slot="form-section-actions">{actions}</div>
        ) : null}
      </div>
      <div className={styles.card} data-slot="form-section-card" data-kind={kind}>
        <SettingsFieldScopeProvider sectionId={sectionId}>{children}</SettingsFieldScopeProvider>
      </div>
    </section>
  );
}
