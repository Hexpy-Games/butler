import { expect, test } from "bun:test";
import { createAppForegroundDoctorView } from "../../packages/butler-app/client/electron/app-foreground-doctor.mjs";

test("Windows foreground Doctor exposes truthful desktop state and recovery actions", () => {
  const doctor = createAppForegroundDoctorView({
    platform: "win32",
    architecture: "x64",
    lifecycleMode: "app-foreground",
    supervisor: {
      phase: "failed",
      containment: {
        kind: "windows_job_object",
        verified: true,
        owner_death_guaranteed: true,
      },
    },
    startupProgress: {
      stage: "agent starting:C:\\Users\\private",
      agent_phase: "failed",
      tray_ready: true,
    },
    startupFailure: { error_code: "health_timeout" },
    instance: {
      containment_kind: "windows_job_object",
      containment_verified: true,
      owner_death_guaranteed: true,
    },
    lastExit: { process_tree_dead: true, port_released: true },
    startAtLogin: true,
  });

  expect(doctor).toMatchObject({
    platform: "win32",
    architecture: "x64",
    lifecycle_mode: "app-foreground",
    phase: "failed",
    startup: {
      stage: "agent_starting:C:_Users_private",
      failure_code: "health_timeout",
      tray_ready: true,
      raw_text_included: false,
    },
    containment: {
      kind: "windows_job_object",
      verified: true,
      owner_death_guaranteed: true,
      last_tree_dead: true,
      last_port_released: true,
    },
    desktop: {
      tray_supported: true,
      start_at_login: true,
      notifications_supported: true,
    },
    actions: ["retry", "diagnostics", "repair", "quit"],
    unsupported: [{
      capability: "windows_service",
      reason: "foreground_app_only",
      raw_text_included: false,
    }],
    raw_text_included: false,
  });
  expect(JSON.stringify(doctor)).not.toContain("C:\\Users");
  expect(JSON.stringify(doctor)).not.toContain("service_registration_pending");
});

test("healthy foreground Doctor offers diagnostics without repair", () => {
  expect(createAppForegroundDoctorView({
    platform: "darwin",
    lifecycleMode: "app-foreground",
    supervisor: { phase: "running" },
  })).toMatchObject({
    phase: "running",
    actions: ["diagnostics"],
    unsupported: [],
  });
});
