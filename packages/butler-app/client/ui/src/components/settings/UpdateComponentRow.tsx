import type {
  ComponentUpdateStatus,
  UpdateComponentId,
} from "@/app/types.ts";
import { Button, Field, FieldLabel, Stack, Typo } from "@/butler-ds";

export const UPDATE_COMPONENTS: UpdateComponentId[] = [
  "app",
  "service",
];

const COMPONENT_LABELS: Record<UpdateComponentId, string> = {
  app: "Butler App",
  service: "Butler Agent",
};

export interface UpdateActionLabels {
  updateApplying: string;
  updateComponent: string;
  upToDate: string;
}

export interface UpdateComponentRowProps {
  status: ComponentUpdateStatus;
  applying: UpdateComponentId | null;
  labels: UpdateActionLabels;
  onApply: (component: UpdateComponentId) => void;
}

export function UpdateComponentRow({
  status,
  applying,
  labels,
  onApply,
}: UpdateComponentRowProps) {
  return (
    <Field
      data-test-id={`update-component-${status.component}`}
      data-test-class="settings-field"
    >
      <Stack align="row" justify="between" cross="center" gap="md" wrap>
        <Stack gap="xs">
          <FieldLabel>{COMPONENT_LABELS[status.component]}</FieldLabel>
          <Typo.Caption>{versionLabel(status)}</Typo.Caption>
        </Stack>
        <Button
          type="button"
          size="sm"
          variant={status.update_available ? "default" : "outline"}
          disabled={!status.update_available || applying !== null}
          onClick={() => onApply(status.component)}
        >
          {buttonLabel(status, applying, labels)}
        </Button>
      </Stack>
    </Field>
  );
}

export function emptyComponentStatus(
  component: UpdateComponentId,
): ComponentUpdateStatus {
  return {
    component,
    current_version: "",
    available_version: "",
    update_available: false,
    channel: "stable",
    artifact_url: null,
    sha256: null,
    signature: null,
    bundled_components: [component],
    update_policy: component === "service" ? "explicit" : "app-user-action",
    restart_policy:
      component === "service"
        ? "restart-service"
        : "restart-app",
    checked_at: "",
    staged: false,
    stage_path: "",
    manifest_source: "",
  };
}

function buttonLabel(
  status: ComponentUpdateStatus,
  applying: UpdateComponentId | null,
  labels: UpdateActionLabels,
): string {
  if (applying === status.component) return labels.updateApplying;
  if (status.update_available) return labels.updateComponent;
  return labels.upToDate;
}

function versionLabel(status: ComponentUpdateStatus): string {
  const current = status.current_version || "-";
  const available = status.available_version || current;
  if (status.update_available) return `${current} -> ${available}`;
  return current;
}
