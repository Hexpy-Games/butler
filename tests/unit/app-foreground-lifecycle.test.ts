import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_FOREGROUND_LIFECYCLE_MODES,
  appForegroundInstancePath,
  createAppForegroundLaunch,
  createRecoveryBudget,
  readAppForegroundInstance,
  resolveAppLifecycleMode,
  transitionAppForeground,
  writeAppForegroundInstance,
  writeAppForegroundLastExit,
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
    });
    const starting = transitionAppForeground(launch.record, "starting", {
      generation: "generation-1",
      patch: { agent_host_pid: 456, process_group_id: 456 },
    });
    expect(starting.agent_host_pid).toBe(456);
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
      portReleased: true,
      errorCode: "secret: should not pass",
    }, () => new Date("2026-07-13T00:00:00Z"));
    expect(exit.error_code).toBe("secret__should_not_pass");
    expect(readFileSync(join(root, "app/runtime/foreground/last-exit.json"), "utf8"))
      .not.toContain("raw prompt");
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
