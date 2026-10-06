import type { ComponentUpdateStatus, UpdateComponentId } from "@/app/types";

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
    platform: isAgent ? "all" : null,
    artifact_url: null,
    sha256: null,
    signature: null,
    bundled_components: [component],
    bundled_agent_version: null,
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
