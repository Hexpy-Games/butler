import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { quitAndInstallAppUpdate } from "../../packages/butler-app/client/electron/app-foreground-update.mjs";

const root = resolve(import.meta.dir, "../..");

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

test("Electron updater IPC is exposed only through the preload bridge and uses the drain helper", () => {
  const main = readFileSync(
    resolve(root, "packages/butler-app/client/electron/main.mjs"),
    "utf8",
  );
  const preload = readFileSync(
    resolve(root, "packages/butler-app/client/electron/preload.cjs"),
    "utf8",
  );
  expect(main).toContain('ipcMain.handle("butler:quit-and-install-update"');
  expect(main).toContain("quitAndInstallAppUpdate({");
  expect(main).toContain("autoUpdater.quitAndInstall()");
  expect(preload).toContain("quitAndInstallUpdate:");
  expect(preload).toContain('ipcRenderer.invoke("butler:quit-and-install-update")');
});
