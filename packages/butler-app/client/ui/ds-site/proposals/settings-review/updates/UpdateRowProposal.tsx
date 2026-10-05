import { appCopy } from "@/app/copy";
import type { ComponentUpdateStatus } from "@/app/types";
import {
  Button, CircleAlert, Field, FieldLabel, IconSlot, Notice, ProgressMeter, Spinner, Stack, Typo,
} from "@/butler-ds";
import { bundledAgentVersionLabel } from "@/components/settings/UpdateComponentRow";
import { t } from "../proposedCopy";
import type { ProposalLocale, UpdateFailure, UpdateStage } from "../state";
import { formatUpdateBytes, UPDATE_BYTES } from "./updateFixture";

// PROPOSAL COPY of components/settings/UpdateComponentRow.tsx (the piece being redesigned).
// Kept as on main: Field + FieldLabel + version caption on the left, one action Button on the
// right, the same test ids. Added: one status line under the version, a ProgressMeter under the
// row while bytes are known, a Spinner line when they are not, and an error Notice on failure.
// The row's button always shows the one action valid in the stage; it never shows the stage.

function StatusLine({ label }: { label: string }) {
  return (
    // One caption line: the slot centers on it (minHeight="line" uses the body line box, which sat
    // the spinner 3px low next to a caption; see DS gaps).
    <Stack align="row" cross="center" gap="xs" role="status">
      <IconSlot size="sm" tone="secondary"><Spinner size={12} /></IconSlot>
      <Typo.Caption tone="secondary">{label}</Typo.Caption>
    </Stack>
  );
}

function versionLabel(status: ComponentUpdateStatus): string {
  const current = status.current_version || "-";
  // As on main (versionLabel in UpdateComponentRow.tsx).
  return status.update_available ? `${current} -> ${status.available_version || current}` : current;
}

export interface UpdateRowProposalProps {
  status: ComponentUpdateStatus;
  stage: UpdateStage;
  failure: UpdateFailure;
  locale: ProposalLocale;
  onAction: (action: "update" | "cancel" | "restart" | "retry") => void;
}

export function UpdateRowProposal({ status, stage, failure, locale, onAction }: UpdateRowProposalProps) {
  const labels = appCopy.settings.actions;
  const active = status.update_available;
  const bundled = bundledAgentVersionLabel(status);
  const { done, total } = UPDATE_BYTES;
  const percent = Math.floor((done / total) * 100);
  const action = !active ? (
    <Button type="button" size="sm" variant="outline" disabled>{labels.upToDate}</Button>
  ) : stage === "available" ? (
    <Button type="button" size="sm" onClick={() => onAction("update")}>{labels.updateComponent}</Button>
  ) : stage === "downloading" || stage === "downloadingUnknown" ? (
    <Button type="button" size="sm" variant="outline" onClick={() => onAction("cancel")}>{appCopy.common.cancel}</Button>
  ) : stage === "ready" ? (
    <Button type="button" size="sm" onClick={() => onAction("restart")}>{t(locale, "settings.updateProgress.restart")}</Button>
  ) : stage === "deferred" ? (
    <Button type="button" size="sm" variant="outline" disabled>{labels.updateAfterWork}</Button>
  ) : stage === "failed" ? (
    <Button type="button" size="sm" onClick={() => onAction("retry")}>{appCopy.settings.sectionState.retry}</Button>
  ) : null;
  const statusLine = !active ? null
    : stage === "checking" ? <StatusLine label={t(locale, "settings.updateProgress.checking")} />
    : stage === "verifying" ? <StatusLine label={t(locale, "settings.updateProgress.verifying")} />
    : stage === "activating" ? <StatusLine label={t(locale, "settings.updateProgress.restarting")} />
    : stage === "downloadingUnknown" ? <StatusLine label={`${t(locale, "settings.updateProgress.downloading")} · ${t(locale, "settings.updateProgress.downloadedBytes", { done: formatUpdateBytes(done, locale) })}`} />
    : stage === "ready" ? <Typo.Caption tone="secondary">{t(locale, "settings.updateProgress.ready")}</Typo.Caption>
    : stage === "deferred" ? <Typo.Caption tone="secondary">{labels.updateDeferred}</Typo.Caption>
    : null;
  return (
    <Field data-test-id={`update-component-${status.component}`} data-test-class="settings-field" data-stage={active ? stage : "upToDate"}>
      <Stack align="row" justify="between" cross="center" gap="md" wrap>
        <Stack gap="xs">
          <FieldLabel>{appCopy.settings.updateComponents[status.component]}</FieldLabel>
          <Typo.Caption>{versionLabel(status)}</Typo.Caption>
          {bundled ? <Typo.Caption>{bundled}</Typo.Caption> : null}
          {statusLine}
        </Stack>
        {action}
      </Stack>
      {active && stage === "downloading" ? (
        <ProgressMeter
          label={t(locale, "settings.updateProgress.downloading")}
          ariaLabel={t(locale, "settings.updateProgress.downloading")}
          value={percent}
          meta={t(locale, "settings.updateProgress.downloadMeta", {
            percent, done: formatUpdateBytes(done, locale), total: formatUpdateBytes(total, locale),
          })}
        />
      ) : null}
      {active && stage === "failed" ? (
        <Notice tone="error" icon={<CircleAlert />} message={t(locale, `settings.updateErrors.${failure}`)} />
      ) : null}
    </Field>
  );
}
