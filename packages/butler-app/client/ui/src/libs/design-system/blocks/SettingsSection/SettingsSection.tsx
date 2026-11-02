import type { ReactNode } from "react";
import { Button } from "../../components/Button";
import { SkeletonRows } from "../../components/Skeleton";
import { EmptyLine } from "../EmptyLine";
import { FormSection, type FormSectionKind } from "../FormSection";
import { Notice } from "../Notice";
import { useSettingsSectionLabels } from "./settingsPageLabels";
import styles from "./SettingsSection.module.css";

export type SettingsSectionKind = FormSectionKind;
export type SettingsSectionState = "ready" | "loading" | "error" | "empty";

/** The list's last row: loads the next page of rows. */
export interface SettingsSectionMore {
  label: string;
  onClick: () => void;
  /** Disables the row while a page loads. */
  busy?: boolean;
}

export interface SettingsSectionProps {
  /** Stable id; settings page schemas list it. */
  id: string;
  /** Required: names what the card holds; never repeats the page title (throws in dev builds). */
  title: string;
  description?: string;
  /** form: stacked fields; list: rows; status: live status rows; info: read-only key/value rows. */
  kind: SettingsSectionKind;
  /**
   * Section actions in the header (add, refresh, filter, period): outline,
   * size sm, right-aligned; only on `kind="list"` and `kind="status"`. Never
   * a setting: a setting is a field in the card.
   */
  actions?: ReactNode;
  /** A "more" last row for paged lists; rendered only when the section is ready. */
  more?: SettingsSectionMore;
  /** Section-level fetch state; `ready` renders the children. */
  state?: SettingsSectionState;
  /** Shows a Retry button in the error state. */
  onRetry?: () => void;
  /** Overrides the page's error copy. */
  errorMessage?: ReactNode;
  /** Overrides the page's empty copy. */
  emptyMessage?: string;
  children?: ReactNode;
}

const SKELETON_ROWS: Record<SettingsSectionKind, number> = { form: 2, list: 3, status: 2, info: 3 };

/**
 * One settings section: header (title, description, actions) above a single
 * card surface. The section owns its loading (skeleton rows shaped by kind),
 * error (Notice with Retry) and empty (EmptyLine) states, and the "more" row
 * of a paged list.
 */
export function SettingsSection({
  id,
  title,
  description,
  kind,
  actions,
  state = "ready",
  onRetry,
  errorMessage,
  emptyMessage,
  more,
  children,
}: SettingsSectionProps) {
  const labels = useSettingsSectionLabels();
  return (
    <FormSection
      sectionId={id}
      kind={kind}
      title={title}
      description={description}
      actions={actions}
      busy={state === "loading"}
    >
      {state === "loading" ? (
        <div data-slot="settings-section-skeleton">
          <SkeletonRows rows={SKELETON_ROWS[kind]} shape={kind === "form" ? "field" : "list"} label={labels.loading} />
        </div>
      ) : state === "error" ? (
        <div data-slot="settings-section-error" role="alert">
          <Notice
            tone="error"
            message={errorMessage ?? labels.error}
            action={onRetry ? (
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>{labels.retry}</Button>
            ) : undefined}
          />
        </div>
      ) : state === "empty" ? (
        <div data-slot="settings-section-empty">
          <EmptyLine message={emptyMessage ?? labels.empty} />
        </div>
      ) : (
        <>
          {children}
          {more ? (
            <div className={styles.more} data-slot="settings-section-more">
              <Button type="button" size="sm" variant="ghost" disabled={more.busy} onClick={more.onClick}>{more.label}</Button>
            </div>
          ) : null}
        </>
      )}
    </FormSection>
  );
}
