import { appCopy } from "@/app/copy.ts";
import type {
  ComponentUpdateStatus,
  UpdateComponentId,
  UpdateProgressView,
} from "@/app/types.ts";
import { updateIsRunning } from "@/stores/updateProgressStore";
import { UpdateProgressPanel } from "./UpdateProgressPanel";
import { Button, Field, FieldLabel, Stack, Typo } from "@/butler-ds";
import {
  bundledAgentVersionLabel,
  UPDATE_COMPONENTS,
} from "./updateComponentDisplay";

export { bundledAgentVersionLabel, UPDATE_COMPONENTS };

export interface UpdateActionLabels {
  updateApplying: string;
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
  labels: UpdateActionLabels;
  onApply: (component: UpdateComponentId) => void;
}

export function UpdateComponentRow({
  status,
  applying,
  labels,
  onApply,
  progress = null,
  onCancel,
}: UpdateComponentRowProps) {
  const bundledAgentDetail = bundledAgentVersionLabel(status);
  return (
    <Field
      data-test-id={`update-component-${status.component}`}
      data-test-class="settings-field"
    >
      <Stack align="row" justify="between" cross="center" gap="md" wrap>
        <Stack gap="xs">
          <FieldLabel>{appCopy.settings.updateComponents[status.component]}</FieldLabel>
          <Typo.Caption>{versionLabel(status)}</Typo.Caption>
          {bundledAgentDetail ? <Typo.Caption>{bundledAgentDetail}</Typo.Caption> : null}
          {status.stage_status === "rolled_back" && status.rollback_reason ? (
            <Typo.Caption>{status.rollback_reason}</Typo.Caption>
          ) : null}
        </Stack>
        <Button
          type="button"
          size="sm"
          variant={status.update_available ? "default" : "outline"}
          disabled={updateIsRunning(progress) || applying !== null || (!status.update_available && progress?.stage !== "failed")}
          onClick={() => onApply(status.component)}
        >
          {progress?.stage === "failed" ? appCopy.settings.updateProgress.retry : updateIsRunning(progress) ? appCopy.settings.updateProgress[progress!.stage] : buttonLabel(status, applying, labels)}
        </Button>
      </Stack>
      {progress && <UpdateProgressPanel progress={progress} onCancel={onCancel} />}
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
