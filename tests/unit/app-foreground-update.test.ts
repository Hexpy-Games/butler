import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  planAppForegroundUpdateStop,
  quitAndInstallAppUpdate,
} from "../../packages/butler-app/client/electron/app-foreground-update.mjs";

const root = resolve(import.meta.dir, "../..");

test("strict update planning requires a drain for every non-empty classification", () => {
  expect(planAppForegroundUpdateStop({
    usesAppForegroundLifecycle: false,
    activeWorkSnapshot: { classification: "no_active_work" },
  })).toEqual({
    allowed: true,
    requiresDrain: false,
    restoreState: null,
    reason: "no_active_work",
  });

  for (const foregroundState of ["starting", "recovering", "failed"]) {
    expect(planAppForegroundUpdateStop({
      usesAppForegroundLifecycle: true,
      foregroundState,
      activeWorkSnapshot: { classification: "active_work_detected" },
    })).toMatchObject({
      allowed: false,
      requiresDrain: true,
      reason: "foreground_drain_unavailable",
    });
  }
  expect(planAppForegroundUpdateStop({
    usesAppForegroundLifecycle: true,
    foregroundState: "ready",
    activeWorkSnapshot: { classification: "active_work_unknown" },
  })).toMatchObject({ allowed: true, requiresDrain: true, restoreState: "ready" });
  expect(planAppForegroundUpdateStop({
    usesAppForegroundLifecycle: true,
    foregroundState: "degraded",
    activeWorkSnapshot: { classification: "active_work_detected" },
  })).toMatchObject({ allowed: true, requiresDrain: true, restoreState: "degraded" });
  expect(planAppForegroundUpdateStop({
    usesAppForegroundLifecycle: true,
    foregroundState: "update_pending",
    restoreState: "ready",
    activeWorkSnapshot: { classification: "active_work_detected" },
  })).toMatchObject({ allowed: true, requiresDrain: true, restoreState: "ready" });
  expect(planAppForegroundUpdateStop({
    usesAppForegroundLifecycle: true,
    foregroundState: "ready",
    activeWorkSnapshot: { classification: "unexpected_classification" },
  })).toMatchObject({ allowed: true, requiresDrain: true });
});

test("update quit waits for active-work drain before invoking the updater", async () => {
  const calls: string[] = [];
  const snapshot = { classification: "active_work_detected" };
  const result = await quitAndInstallAppUpdate({
    readActiveWork: async () => {
      calls.push("read");
      return snapshot;
    },
    confirmQuit: async (actual) => {
      expect(actual).toBe(snapshot);
      calls.push("confirm");
      return true;
    },
    stopForUpdate: async (actual) => {
      expect(actual).toBe(snapshot);
      calls.push("drain-stop");
      return { update_ready: true };
    },
    quitAndInstall: () => {
      calls.push("quit-install");
    },
  });

  expect(calls).toEqual(["read", "confirm", "drain-stop", "quit-install"]);
  expect(result).toEqual({
    status: "update_started",
    update_started: true,
    raw_text_included: false,
  });
});

test("update quit preserves active work when consent is cancelled", async () => {
  let stopped = false;
  let installed = false;
  const result = await quitAndInstallAppUpdate({
    readActiveWork: async () => ({ classification: "active_work_unknown" }),
    confirmQuit: async () => false,
    stopForUpdate: async () => {
      stopped = true;
    },
    quitAndInstall: () => {
      installed = true;
    },
  });
  expect(result).toMatchObject({ status: "cancelled", update_started: false });
  expect(stopped).toBeFalse();
  expect(installed).toBeFalse();
});

test("update quit blocks install when the strict drain gate is not settled", async () => {
  let installed = false;
  const result = await quitAndInstallAppUpdate({
    readActiveWork: async () => ({ classification: "active_work_detected" }),
    confirmQuit: async () => true,
    stopForUpdate: async () => ({
      update_ready: false,
      drain: {
        status: "deadline_exceeded",
        settled: false,
        cancellation_failures: 0,
      },
    }),
    quitAndInstall: () => {
      installed = true;
    },
  });

  expect(result).toMatchObject({
    status: "drain_failed",
    update_started: false,
    drain: { status: "deadline_exceeded", settled: false },
  });
  expect(installed).toBeFalse();
});

test("update quit fails closed when the stop contract does not confirm readiness", async () => {
  let installed = false;
  const result = await quitAndInstallAppUpdate({
    readActiveWork: async () => ({ classification: "no_active_work" }),
    confirmQuit: async () => true,
    stopForUpdate: async () => undefined,
    quitAndInstall: () => {
      installed = true;
    },
  });

  expect(result).toMatchObject({
    status: "drain_failed",
    update_started: false,
    drain: null,
  });
  expect(installed).toBeFalse();
});

test("update quit blocks install when cancellation requests do not settle", async () => {
  let installed = false;
  const result = await quitAndInstallAppUpdate({
    readActiveWork: async () => ({ classification: "active_work_detected" }),
    confirmQuit: async () => true,
    stopForUpdate: async () => ({
      update_ready: false,
      drain: {
        status: "settled_with_request_errors",
        settled: true,
        cancellation_failures: 1,
      },
    }),
    quitAndInstall: () => {
      installed = true;
    },
  });

  expect(result).toMatchObject({ status: "drain_failed", update_started: false });
  expect(installed).toBeFalse();
});

test("Electron updater IPC is exposed only through the preload bridge and uses the drain helper", () => {
  const main = readFileSync(
    resolve(root, "packages/butler-app/client/electron/main.mjs"),
    "utf8",
  );
  const preload = readFileSync(
    resolve(root, "packages/butler-app/client/electron/preload.cjs"),
    "utf8",
  );
  const smoke = readFileSync(
    resolve(root, "packages/butler-app/scripts/windows/active-work-cancellation-smoke.ts"),
    "utf8",
  );
  expect(main).toContain('ipcMain.handle("butler:quit-and-install-update"');
  expect(main).toContain("quitAndInstallAppUpdate({");
  expect(main).toContain("planAppForegroundUpdateStop");
  expect(main).toContain("requireSettledDrain: true");
  expect(main).toContain("foregroundDrainReadyForUpdate");
  expect(main).toContain("restoreForegroundAfterUpdateDrainFailure");
  expect(main).toContain("autoUpdater.quitAndInstall()");
  expect(smoke).toContain("return { update_ready: true }");
  expect(preload).toContain("quitAndInstallUpdate:");
  expect(preload).toContain('ipcRenderer.invoke("butler:quit-and-install-update")');
});
