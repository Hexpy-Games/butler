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
          {status.stage_status === "rolled_back" && status.rollback_reason ? (
            <Typo.Caption>{status.rollback_reason}</Typo.Caption>
          ) : null}
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
  const isAgent = component === "service";
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
    product: isAgent ? "butler-agent" : "butler-app",
    canonical_component: isAgent ? "agent" : "app",
    profile: isAgent ? "agent-standalone" : "electron",
    protocol_compatibility: isAgent
      ? {
          protocol: "butler.agent.v1",
          minimumAgentProtocol: "butler.agent.v1",
          maximumAgentProtocol: "butler.agent.v1",
        }
      : {
          protocol: "butler.app.v1",
          minimumAppProtocol: "butler.app.v1",
          maximumAppProtocol: "butler.app.v1",
        },
    integrity: {
      digestAlgorithm: "sha256",
      digest: null,
      signature: null,
    },
    update_policy: isAgent ? "explicit" : "app-user-action",
    restart_policy: isAgent ? "restart-service" : "restart-app",
    updater_owner: isAgent ? "butler-agent" : "butler-app",
    payload_format: isAgent ? "agent-archive" : "platform-app-package",
    staging_policy: isAgent ? "butler-data-updates" : "platform-updater-cache",
    activation_policy: isAgent
      ? "versioned-standalone-runtime"
      : "platform-app-update-then-versioned-app-runtime",
    rollback_policy: isAgent
      ? "preserve-previous-standalone-runtime"
      : "preserve-previous-app-managed-runtime",
    checked_at: "",
    staged: false,
    stage_path: "",
    stage_status: "up_to_date",
    activation_status: "not_required",
    active_runtime_path: null,
    attempted_runtime_path: null,
    previous_runtime_path: null,
    rollback_reason: null,
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
