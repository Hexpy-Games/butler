export const APP_FOREGROUND_DOCTOR_SCHEMA =
  "butler.app-foreground-doctor.v1";

export function createAppForegroundDoctorView({
  platform = process.platform,
  architecture = process.arch,
  lifecycleMode,
  supervisor = {},
  startupProgress = null,
  startupFailure = null,
  instance = null,
  lastExit = null,
  trayReady = false,
  startAtLogin = false,
  notificationsSupported = true,
} = {}) {
  const failed = supervisor?.phase === "failed" || Boolean(startupFailure);
  const foregroundOnly = lifecycleMode === "app-foreground";
  return {
    schema: APP_FOREGROUND_DOCTOR_SCHEMA,
    platform: safeString(platform),
    architecture: safeString(architecture),
    lifecycle_mode: safeString(lifecycleMode),
    phase: safeCode(supervisor?.phase) ?? "unavailable",
    startup: {
      stage: safeCode(startupProgress?.stage),
      failure_code: safeCode(startupFailure?.error_code),
      agent_phase: safeCode(startupProgress?.agent_phase),
      tray_ready:
        trayReady === true || startupProgress?.tray_ready === true,
      window_ready: startupProgress?.window_ready === true,
      raw_text_included: false,
    },
    containment: {
      kind:
        safeString(instance?.containment_kind) ??
        safeString(supervisor?.containment?.kind),
      verified:
        instance?.containment_verified === true ||
        supervisor?.containment?.verified === true,
      owner_death_guaranteed:
        instance?.owner_death_guaranteed === true ||
        supervisor?.containment?.owner_death_guaranteed === true,
      last_tree_dead: lastExit?.process_tree_dead === true,
      last_port_released: lastExit?.port_released === true,
      raw_text_included: false,
    },
    desktop: {
      tray_supported: true,
      start_at_login: startAtLogin === true,
      notifications_supported: notificationsSupported === true,
      raw_text_included: false,
    },
    actions: failed
      ? ["retry", "diagnostics", "repair", "quit"]
      : ["diagnostics"],
    unsupported: foregroundOnly && platform === "win32"
      ? [{
          capability: "windows_service",
          reason: "foreground_app_only",
          raw_text_included: false,
        }]
      : [],
    raw_text_included: false,
  };
}

function safeString(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 120)
    : null;
}

function safeCode(value) {
  const text = safeString(value);
  return text
    ? text.replace(/[^a-z0-9_:-]/giu, "_").slice(0, 80)
    : null;
}
