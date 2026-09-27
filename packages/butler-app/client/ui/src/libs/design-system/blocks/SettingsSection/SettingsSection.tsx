import type { ReactNode } from "react";
import { Button } from "../../components/Button";
import { SkeletonRows } from "../../components/Skeleton";
import { EmptyLine } from "../EmptyLine";
import { FormSection, type FormSectionKind } from "../FormSection";
import { Notice } from "../Notice";
import { useSettingsSectionLabels } from "./settingsPageLabels";

export type SettingsSectionKind = FormSectionKind;
export type SettingsSectionState = "ready" | "loading" | "error" | "empty";

export interface SettingsSectionProps {
  /** Stable id; settings page schemas list it. */
  id: string;
  /** Omit when it would repeat the page title. */
  title?: string;
  description?: string;
  /** form: stacked fields; list: rows; status: live status rows; info: read-only key/value rows. */
  kind: SettingsSectionKind;
  /** Header toolbar (page-level controls of a single-list page, compact header controls). */
  actions?: ReactNode;
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
 * One settings section: header (title, description, toolbar) above a single
 * card surface. The section owns its loading (skeleton rows shaped by kind),
 * error (Notice with Retry) and empty (EmptyLine) states.
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
      ) : children}
    </FormSection>
  );
}
