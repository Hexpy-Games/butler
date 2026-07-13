export const APP_AGENT_SERVICE_STATUSES = [
  "not_installed",
  "installing",
  "starting",
  "ready",
  "stopped",
  "failed",
  "needs_permission",
  "draining",
  "updating",
  "restarting",
  "rollback",
] as const;

export type AppAgentServiceStatus = (typeof APP_AGENT_SERVICE_STATUSES)[number];

export const APP_AGENT_UPDATE_STATUSES = [
  "idle",
  "update_available",
  "staging",
  "draining",
  "restart_required",
  "restarting",
  "candidate_ready",
  "promoting",
  "ready",
  "rollback",
  "failed",
] as const;

export type AppAgentUpdateStatus = (typeof APP_AGENT_UPDATE_STATUSES)[number];

export const APP_BACKGROUND_SERVICE_RUNTIME_FIELDS = [
  "BUTLER_HOME",
  "BUTLER_DATA",
  "BUTLER_BUN",
  "BUTLER_APP_MANAGED_RUNTIME_POINTER",
  "BUTLER_APP_MANAGED_RUNTIME_HOME",
  "BUTLER_APP_SERVER_HOST",
  "BUTLER_APP_SERVER_PORT",
  "BUTLER_APP_GATEWAY_PID_FILE",
  "BUTLER_APP_LOCAL_AUTH_REQUIRED",
  "BUTLER_APP_LOCAL_AUTH_FILE",
] as const;

export const APP_AGENT_UPDATE_TRANSACTION_FIELDS = [
  "schema",
  "generation",
  "status",
  "previous_active_pointer",
  "active_pointer",
  "candidate_pointer",
  "candidate_digest",
  "candidate_boot_token_hash",
  "readiness_proof",
  "started_at",
  "updated_at",
  "last_error",
] as const;

export const APP_AGENT_CANDIDATE_BOOT_TOKEN_FIELDS = [
  "generation",
  "candidate_pointer",
  "candidate_digest",
  "token",
] as const;

export type AppBackgroundServicePlatform = "darwin" | "linux" | "win32";

export type AppBackgroundServiceImplementationPhase =
  | "phase-2-service-control"
  | "phase-3-first-run-service-ui"
  | "phase-6-installer-packaging";

export type AppBackgroundServiceRequiredDecision =
  | "app-foreground-lifecycle"
  | "macos-registration-path"
  | "windows-user-security-context"
  | "linux-package-service-path";

export type AppBackgroundServiceV1Path =
  | "macos-app-foreground"
  | "linux-app-foreground"
  | "windows-app-foreground"
  | "macos-pkg-launch-agent"
  | "macos-first-run-launch-agent"
  | "macos-smappservice-helper"
  | "windows-per-user-agent-at-sign-in"
  | "windows-least-privilege-user-service"
  | "windows-split-elevated-helper"
  | "linux-systemd-user-service"
  | "linux-deb-owned-user-unit"
  | "linux-pacman-owned-user-unit"
  | "linux-rpm-owned-user-unit";

export interface AppBackgroundServiceCapability {
  platform: AppBackgroundServicePlatform;
  primaryMechanism: string;
  allowedMechanisms: string[];
  requiredDecision: AppBackgroundServiceRequiredDecision;
  allowedV1Paths: AppBackgroundServiceV1Path[];
  selectedV1Path: AppBackgroundServiceV1Path | null;
  blocksBeforePhase: AppBackgroundServiceImplementationPhase;
  installerRequired: "yes" | "no" | "conditional";
  userContext: string;
  implementationStartsAfterPhase0: boolean;
}

export const APP_BACKGROUND_SERVICE_CAPABILITIES: AppBackgroundServiceCapability[] = [
  {
    platform: "darwin",
    primaryMechanism: "App-owned foreground child",
    allowedMechanisms: ["app-foreground-child"],
    requiredDecision: "app-foreground-lifecycle",
    allowedV1Paths: ["macos-app-foreground"],
    selectedV1Path: "macos-app-foreground",
    blocksBeforePhase: "phase-2-service-control",
    installerRequired: "no",
    userContext: "signed-in user",
    implementationStartsAfterPhase0: true,
  },
  {
    platform: "win32",
    primaryMechanism: "App-owned foreground child",
    allowedMechanisms: ["app-foreground-child"],
    requiredDecision: "app-foreground-lifecycle",
    allowedV1Paths: ["windows-app-foreground"],
    selectedV1Path: "windows-app-foreground",
    blocksBeforePhase: "phase-2-service-control",
    installerRequired: "no",
    userContext: "signed-in desktop user",
    implementationStartsAfterPhase0: true,
  },
  {
    platform: "linux",
    primaryMechanism: "App-owned foreground child",
    allowedMechanisms: ["app-foreground-child"],
    requiredDecision: "app-foreground-lifecycle",
    allowedV1Paths: ["linux-app-foreground"],
    selectedV1Path: "linux-app-foreground",
    blocksBeforePhase: "phase-2-service-control",
    installerRequired: "no",
    userContext: "signed-in desktop user",
    implementationStartsAfterPhase0: true,
  },
];

export function appBackgroundServiceCapability(
  platform: AppBackgroundServicePlatform,
): AppBackgroundServiceCapability {
  const capability = APP_BACKGROUND_SERVICE_CAPABILITIES.find(
    (item) => item.platform === platform,
  );
  if (!capability) {
    throw new Error(`unsupported App background service platform: ${platform}`);
  }
  return capability;
}

export function isAppAgentServiceStatus(
  value: unknown,
): value is AppAgentServiceStatus {
  return typeof value === "string" &&
    APP_AGENT_SERVICE_STATUSES.includes(value as AppAgentServiceStatus);
}

export function isAppAgentUpdateStatus(
  value: unknown,
): value is AppAgentUpdateStatus {
  return typeof value === "string" &&
    APP_AGENT_UPDATE_STATUSES.includes(value as AppAgentUpdateStatus);
}
