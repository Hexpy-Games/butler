import type { SettingsView } from "../../interface/protocol/app-protocol.ts";

const APP_WORKSPACE_REQUIRED_TOOL_NAMES = new Set([
  "run_command",
  "read_tool_output_artifact",
]);

export function appRuntimePolicy(input: {
  existing?: unknown;
  accessMode: SettingsView["access_mode"];
  projectId?: string | null;
  sessionKind?: string | null;
}): Record<string, unknown> {
  const existing = input.existing &&
      typeof input.existing === "object" &&
      !Array.isArray(input.existing)
    ? input.existing as Record<string, unknown>
    : {};
  const tracking = runtimeTrackingMode({
    existing,
    projectId: input.projectId,
    sessionKind: input.sessionKind,
  });
  const trackingMode = tracking.mode;
  const requestedProfiles = [
    ...existingProfilesForTracking(existing.requiredNativeToolProfiles, trackingMode),
    ...workspaceProfilesForAccessMode(input.accessMode),
    ...requiredProfilesForTracking(trackingMode, input.accessMode),
  ];
  const closeoutStrategy = closeoutStrategyForTrackingMode(trackingMode);

  return {
    ...existing,
    accessMode: input.accessMode,
    trackingMode,
    tracking_mode: trackingMode,
    trackingModeSource: tracking.source,
    tracking_mode_source: tracking.source,
    closeoutStrategy,
    closeout_strategy: closeoutStrategy,
    requiredNativeTools: requiredToolsForAccessMode(
      existing.requiredNativeTools,
      input.accessMode,
    ),
    required_tools: requiredToolsForAccessMode(
      existing.required_tools,
      input.accessMode,
    ),
    requiredNativeToolProfiles: [...new Set(requestedProfiles)],
  };
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string =>
      typeof item === "string" && item.trim().length > 0,
    )
      .map((item) => item.trim())
    : [];
}

function requiredToolsForAccessMode(
  value: unknown,
  accessMode: SettingsView["access_mode"],
): string[] {
  const names = stringArray(value);
  return accessMode === "full_access"
    ? names
    : names.filter((name) => !APP_WORKSPACE_REQUIRED_TOOL_NAMES.has(name));
}

function workspaceProfilesForAccessMode(accessMode: SettingsView["access_mode"]): string[] {
  return accessMode === "full_access" ? ["workspace"] : [];
}

function existingProfilesForTracking(value: unknown, mode: "ledger" | "local" | "none"): string[] {
  const dropped = new Set(mode === "ledger"
    ? ["workspace"]
    : ["workspace", "project", "project-lifecycle"]);
  return stringArray(value).filter((profile) => !dropped.has(profile));
}

function requiredProfilesForTracking(
  mode: "ledger" | "local" | "none",
  accessMode: SettingsView["access_mode"],
): string[] {
  if (mode !== "ledger") return [];
  return accessMode === "read_only"
    ? ["project"]
    : ["project", "project-lifecycle"];
}

function runtimeTrackingMode(input: {
  existing: Record<string, unknown>;
  projectId?: string | null;
  sessionKind?: string | null;
}): { mode: "ledger" | "local" | "none"; source: TrackingModeSource } {
  const existingMode = trackingModeValue(input.existing.tracking_mode ?? input.existing.trackingMode);
  const existingSource = trackingModeSourceValue(
    input.existing.tracking_mode_source ?? input.existing.trackingModeSource,
  );
  if (existingMode && existingSource === "explicit") return { mode: existingMode, source: existingSource };
  if (input.projectId?.trim()) return { mode: "ledger", source: "app_project_default" };
  if (existingMode) return { mode: existingMode, source: existingSource ?? "legacy_metadata" };
  if (input.sessionKind === "project") return { mode: "local", source: "project_shell_default" };
  return { mode: "none", source: "session_default" };
}

function trackingModeValue(value: unknown): "ledger" | "local" | "none" | null {
  return value === "ledger" || value === "local" || value === "none" ? value : null;
}

type TrackingModeSource =
  | "explicit"
  | "app_project_default"
  | "legacy_metadata"
  | "project_shell_default"
  | "session_default";

function trackingModeSourceValue(value: unknown): TrackingModeSource | null {
  return value === "explicit" ||
      value === "app_project_default" ||
      value === "legacy_metadata" ||
      value === "project_shell_default" ||
      value === "session_default"
    ? value
    : null;
}

function closeoutStrategyForTrackingMode(mode: "ledger" | "local" | "none"): "ledger" | "local_workstream" | "noop" {
  if (mode === "ledger") return "ledger";
  if (mode === "local") return "local_workstream";
  return "noop";
}
