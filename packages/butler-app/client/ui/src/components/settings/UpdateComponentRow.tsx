import { appCopy } from "@/app/copy.ts";
import type {
  ComponentUpdateStatus,
  UpdateComponentId,
  UpdateProgressView,
} from "@/app/types.ts";
import { UpdateStatusLine } from "./UpdateStatusLine";
import { UpdateProgressPanel } from "./UpdateProgressPanel";
import { Button, Field, FieldLabel, Stack, Typo } from "@/butler-ds";
import {
  bundledAgentVersionLabel,
  UPDATE_COMPONENTS,
} from "./updateComponentDisplay";

export { bundledAgentVersionLabel, UPDATE_COMPONENTS };

export interface UpdateActionLabels {
  updateApplying: string;
  updateAfterWork: string;
  updateDeferred: string;
  updateRestarting: string;
  updateChecking: string;
  updateComponent: string;
  updateUnavailable: string;
  upToDate: string;
}

export interface UpdateComponentRowProps {
  status: ComponentUpdateStatus;
  applying: UpdateComponentId | null;
  progress?: UpdateProgressView | null;
  onCancel?: () => void;
  restartStatus?: string;
  labels: UpdateActionLabels;
  onApply: (component: UpdateComponentId) => void;
}

export function UpdateComponentRow({
  status,
  applying,
  restartStatus,
  labels,
  onApply,
  progress = null,
  onCancel,
}: UpdateComponentRowProps) {
  const stage = progress?.error_code === "update_cancelled" ? "idle" : progress?.stage;
  const deferred = status.component === "app" && restartStatus === "deferred";
  const restartRunning = status.component === "app" && ["preparing", "restarting", "choice_required"].includes(restartStatus ?? "");
  const busy = restartRunning || ["checking", "verifying", "applying", "restarting"].includes(stage ?? "");
  const cancelling = stage === "downloading" && progress?.cancellable && onCancel;
  const unknownDownload = stage === "downloading" && !(progress?.bytes_total && progress.bytes_total > 0);
  const copy = appCopy.settings.updateProgress;
  const bundledAgentDetail = bundledAgentVersionLabel(status);
  return (
    <Field
      data-test-id={`update-component-${status.component}`}
      data-test-class="settings-field"
      data-stage={deferred ? "deferred" : stage ?? "idle"}
    >
      <Stack align="row" justify="between" cross="center" gap="md" wrap>
        <Stack gap="xs">
          <FieldLabel>{appCopy.settings.updateComponents[status.component]}</FieldLabel>
          <Typo.Caption>{versionLabel(status)}</Typo.Caption>
          {bundledAgentDetail ? <Typo.Caption>{bundledAgentDetail}</Typo.Caption> : null}
          {deferred ? <Typo.Caption tone="secondary">{labels.updateDeferred}</Typo.Caption>
            : busy ? <UpdateStatusLine label={["checking", "verifying", "applying", "restarting"].includes(stage ?? "") ? copy[stage as "checking" | "verifying" | "applying" | "restarting"] : copy.restarting} />
            : stage === "ready" ? <Typo.Caption tone="secondary">{copy.ready}</Typo.Caption> : null}
          {unknownDownload && progress && <UpdateProgressPanel progress={progress} />}
        </Stack>
        {!busy && (stage !== "downloading" || cancelling) && <Button
          type="button" size="sm"
          variant={cancelling || deferred || !status.update_available ? "outline" : "default"}
          disabled={deferred || (!status.update_available && stage !== "failed" && stage !== "ready" && !cancelling) || (applying !== null && stage !== "ready" && !cancelling)}
          onClick={cancelling ? onCancel : () => onApply(status.component)}
        >
          {cancelling ? copy.cancel : deferred ? labels.updateAfterWork : stage === "failed" ? copy.retry
            : stage === "ready" ? copy.restart : buttonLabel(status, applying, labels)}
        </Button>}
      </Stack>
      {progress && !unknownDownload && <UpdateProgressPanel progress={progress} />}
    </Field>
  );
}

export { emptyComponentStatus } from "./emptyComponentStatus";

function buttonLabel(
  status: ComponentUpdateStatus,
  applying: UpdateComponentId | null,
  labels: UpdateActionLabels,
): string {
  if (applying === status.component) return labels.updateApplying;
  if (status.update_available) return labels.updateComponent;
  if (status.check_state === "unavailable") return labels.updateUnavailable;
  if (status.check_state === "unchecked") return labels.updateChecking;
  return labels.upToDate;
}

function versionLabel(status: ComponentUpdateStatus): string {
  const current = status.current_version || "-";
  const available = status.available_version || current;
  if (status.update_available) return `${current} -> ${available}`;
  return current;
}
