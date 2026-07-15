import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_FOREGROUND_LIFECYCLE_MODES,
  appForegroundInstancePath,
  appForegroundStartupFailurePath,
  appForegroundStartupProgressPath,
  clearAppForegroundStartupFailure,
  createAppForegroundLaunch,
  createRecoveryBudget,
  readAppForegroundInstance,
  resolveAppLifecycleMode,
  transitionAppForeground,
  writeAppForegroundInstance,
  writeAppForegroundLastExit,
  writeAppForegroundStartupFailure,
  writeAppForegroundStartupProgress,
} from "../../packages/butler-app/client/electron/app-foreground-lifecycle.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("App foreground lifecycle", () => {
  test("uses structured macOS policy and requires consent for overrides", () => {
    expect(resolveAppLifecycleMode({ platform: "darwin", isPackaged: true }))
      .toBe(APP_FOREGROUND_LIFECYCLE_MODES.foreground);
    expect(resolveAppLifecycleMode({ platform: "linux", isPackaged: true }))
      .toBe(APP_FOREGROUND_LIFECYCLE_MODES.foreground);
    expect(resolveAppLifecycleMode({ platform: "win32", isPackaged: true }))
      .toBe(APP_FOREGROUND_LIFECYCLE_MODES.foreground);
    expect(() => resolveAppLifecycleMode({
      platform: "darwin",
      isPackaged: true,
      env: { BUTLER_APP_AGENT_LIFECYCLE_MODE: "native-service" },
    })).toThrow("isolated-test consent");
    expect(resolveAppLifecycleMode({
      platform: "darwin",
      isPackaged: true,
      env: {
        BUTLER_APP_AGENT_LIFECYCLE_MODE: "native-service",
        BUTLER_APP_ALLOW_LIFECYCLE_TEST_OVERRIDE: "1",
      },
    })).toBe("native-service");
  });

  test("rejects stale and invalid transitions", () => {
    const launch = createAppForegroundLaunch({
      appVersion: "1.2.3",
      bundledAgentVersion: "1.2.3",
      port: 18765,
      appPid: 123,
      now: () => new Date("2026-07-13T00:00:00Z"),
      generateGeneration: () => "generation-1",
      generateNonce: () => "n".repeat(32),
      platform: "win32",
      architecture: "x64",
    });
    const starting = transitionAppForeground(launch.record, "starting", {
      generation: "generation-1",
      patch: {
        agent_host_pid: 456,
        containment_kind: "windows_job_object",
        containment_verified: true,
        owner_death_guaranteed: true,
      },
    });
    expect(starting.agent_host_pid).toBe(456);
    expect(starting).toMatchObject({
      process_group_id: null,
      platform: "win32",
      architecture: "x64",
      containment_kind: "windows_job_object",
      containment_verified: true,
      owner_death_guaranteed: true,
    });
    expect(() => transitionAppForeground(starting, "ready", {
      generation: "stale-generation",
    })).toThrow("stale");
    expect(() => transitionAppForeground(starting, "not_started"))
      .toThrow("invalid App foreground transition");
  });

  test("persists private instance and redacted exit records atomically", () => {
    const root = mkdtempSync(join(tmpdir(), "butler-afal-"));
    roots.push(root);
    const launch = createAppForegroundLaunch({
      appVersion: "1.2.3",
      bundledAgentVersion: "1.2.3",
      port: 18765,
      appPid: 123,
    });
    writeAppForegroundInstance(root, launch.record);
    expect(readAppForegroundInstance(root)?.generation).toBe(launch.record.generation);
    expect(statSync(appForegroundInstancePath(root)).mode & 0o777).toBe(0o600);
    const exit = writeAppForegroundLastExit(root, {
      generation: launch.record.generation,
      exitReason: "user_quit",
      graceful: true,
      processGroupDead: true,
      processTreeDead: true,
      portReleased: true,
      errorCode: "secret: should not pass",
    }, () => new Date("2026-07-13T00:00:00Z"));
    expect(exit.error_code).toBe("secret__should_not_pass");
    expect(exit.process_tree_dead).toBe(true);
    expect(readFileSync(join(root, "app/runtime/foreground/last-exit.json"), "utf8"))
      .not.toContain("raw prompt");
  });

  test("persists enum-only startup failure diagnostics", () => {
    const root = mkdtempSync(join(tmpdir(), "butler-foreground-failure-"));
    const failure = writeAppForegroundStartupFailure(root, {
      platform: "win32",
      architecture: "x64",
      lifecycleMode: "app-foreground",
      supervisorPhase: "failed",
      errorCode: "early_exit:C:\\Users\\secret",
      exitCode: 125,
      signal: "SIGTERM",
      containmentKind: "windows_job_object",
      containmentVerified: true,
      ownerDeathGuaranteed: true,
    }, () => new Date("2026-07-15T00:00:00Z"));

    expect(failure).toMatchObject({
      error_code: "early_exit_C__Users_secret",
      exit_code: 125,
      containment_kind: "windows_job_object",
      raw_text_included: false,
    });
    expect(readFileSync(appForegroundStartupFailurePath(root), "utf8"))
      .not.toContain("C:\\Users");
    clearAppForegroundStartupFailure(root);
    expect(() => readFileSync(appForegroundStartupFailurePath(root), "utf8"))
      .toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  test("persists redacted startup progress", () => {
    const root = mkdtempSync(join(tmpdir(), "butler-foreground-progress-"));
    const progress = writeAppForegroundStartupProgress(root, {
      stage: "agent ready:C:\\secret",
      platform: "win32",
      architecture: "x64",
      lifecycleMode: "app-foreground",
      agentPhase: "running",
      containmentKind: "windows_job_object",
      trayReady: true,
    }, () => new Date("2026-07-15T00:00:00Z"));
    expect(progress).toMatchObject({
      stage: "agent_ready_C__secret",
      agent_phase: "running",
      tray_ready: true,
      raw_text_included: false,
    });
    expect(readFileSync(appForegroundStartupProgressPath(root), "utf8"))
      .not.toContain("C:\\secret");
    rmSync(root, { recursive: true, force: true });
  });

  test("bounds recovery attempts in a rolling window", () => {
    const budget = createRecoveryBudget({ maxAttempts: 3, windowMs: 60_000 });
    expect(budget.record(0)).toBeTrue();
    expect(budget.record(10)).toBeTrue();
    expect(budget.record(20)).toBeTrue();
    expect(budget.record(30)).toBeFalse();
    expect(budget.record(60_000)).toBeTrue();
  });
});
