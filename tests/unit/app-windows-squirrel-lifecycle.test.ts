import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  executeWindowsSquirrelLaunch,
  manageWindowsSquirrelShortcut,
  removeWindowsOperationalState,
  resolveWindowsSquirrelLaunch,
  resolveWindowsUpdateFeedUrl,
  shouldDelayWindowsFirstUpdateCheck,
  verifyWindowsInstallerPublisher,
  WINDOWS_APP_USER_MODEL_ID,
  windowsLoginItemSettings,
  windowsOperationalCleanupPaths,
} from "../../packages/butler-app/client/electron/windows-squirrel-lifecycle.mjs";
import { windowsPowerShellEnvironment } from
  "../../packages/butler-app/client/electron/windows-powershell-environment.mjs";

describe("Windows Squirrel lifecycle", () => {
  test("Electron handles Squirrel before single-instance and supervisor setup", () => {
    const main = readFileSync(resolve(
      import.meta.dir,
      "../../packages/butler-app/client/electron/main.mjs",
    ), "utf8");
    const handler = main.indexOf("if (windowsSquirrelLaunch.handled)");
    expect(handler).toBeGreaterThan(0);
    expect(handler).toBeLessThan(main.indexOf("createBundledAgentSupervisor({"));
    expect(handler).toBeLessThan(main.indexOf("app.requestSingleInstanceLock()"));
    expect(main).toContain("normalInitializationReached: false");
  });

  test("release-cycle cleanup keeps PowerShell boolean expressions intact", () => {
    const smoke = readFileSync(resolve(
      import.meta.dir,
      "../../packages/butler-app/scripts/windows/windows-squirrel-release-cycle-smoke.ts",
    ), "utf8");
    expect(smoke).not.toContain("-or;");
    expect(smoke).toContain('].join(" ");');
    expect(smoke).toContain("runSquirrelUpdate(outCurrent);");
    expect(smoke).not.toContain("runInstaller(currentSetup);");
  });

  test("handles install and update events before normal app initialization", () => {
    for (const event of ["--squirrel-install", "--squirrel-updated"]) {
      const plan = resolveWindowsSquirrelLaunch({
        platform: "win32",
        argv: ["Butler.exe", event, "0.0.19"],
        execPath: "C:\\Users\\dev user\\AppData\\Local\\butler-app\\app-0.0.19\\Butler.exe",
      });
      expect(plan).toMatchObject({
        handled: true,
        event,
        shortcutAction: "create",
        stubLauncher:
          "C:\\Users\\dev user\\AppData\\Local\\butler-app\\Butler.exe",
        shortcutName: "Butler.lnk",
        appUserModelId: "com.squirrel.butler-app.Butler",
        registerProtocol: true,
        removeOperationalState: false,
      });
    }
  });

  test("uninstall removes only App operational state and preserves durable data", () => {
    const plan = resolveWindowsSquirrelLaunch({
      platform: "win32",
      argv: ["Butler.exe", "--squirrel-uninstall", "0.0.19"],
      execPath: "C:\\Users\\dev\\AppData\\Local\\butler-app\\app-0.0.19\\Butler.exe",
    });
    const calls: Array<[string, unknown]> = [];
    const result = executeWindowsSquirrelLaunch(plan, {
      manageShortcut: (input: unknown) => {
        calls.push(["shortcut", input]);
        return true;
      },
      setLoginItemSettings: (settings: unknown) => calls.push(["login", settings]),
      unregisterProtocol: (_scheme: string, executable: string) => {
        calls.push(["protocol", executable]);
        return true;
      },
      cleanupOperationalState: () => {
        calls.push(["cleanup", true]);
        return [];
      },
    });
    expect(result).toMatchObject({
      handled: true,
      event: "--squirrel-uninstall",
      shortcutAction: "remove",
      operationalStateRemoved: true,
    });
    expect(calls.map(([kind]) => kind)).toEqual([
      "login",
      "protocol",
      "cleanup",
      "shortcut",
    ]);
    expect(windowsOperationalCleanupPaths("C:\\Users\\dev\\.butler")).toEqual([
      "C:\\Users\\dev\\.butler\\app\\runtime",
      "C:\\Users\\dev\\.butler\\updates",
    ]);
    expect(windowsOperationalCleanupPaths("C:\\Users\\dev\\.butler")).not.toContain(
      "C:\\Users\\dev\\.butler",
    );
  });

  test("operational cleanup uses bounded idempotent removals", () => {
    const removed: string[] = [];
    expect(removeWindowsOperationalState({
      butlerData: "C:\\Users\\dev\\.butler",
      removePath: (path: string) => removed.push(path),
    })).toEqual(removed);
    expect(removed).toHaveLength(2);
  });

  test("obsolete exits without managing shortcuts and first run stays normal", () => {
    const obsolete = resolveWindowsSquirrelLaunch({
      platform: "win32",
      argv: ["Butler.exe", "--squirrel-obsolete"],
      execPath: "C:\\app-0.0.18\\Butler.exe",
    });
    expect(executeWindowsSquirrelLaunch(obsolete, {
      manageShortcut: () => {
        throw new Error("must not run");
      },
    })).toMatchObject({ handled: true, shortcutAction: null });

    const firstRun = resolveWindowsSquirrelLaunch({
      platform: "win32",
      argv: ["Butler.exe", "--squirrel-firstrun"],
      execPath: "C:\\app-0.0.19\\Butler.exe",
    });
    expect(firstRun).toMatchObject({ handled: false, firstRun: true });
    expect(shouldDelayWindowsFirstUpdateCheck({
      platform: "win32",
      argv: ["Butler.exe", "--squirrel-firstrun"],
    })).toBe(true);
  });

  test("Start Menu shortcut targets the version-independent Squirrel stub", () => {
    let command = "";
    let environment: NodeJS.ProcessEnv = {};
    expect(manageWindowsSquirrelShortcut({
      action: "create",
      name: "Butler.lnk",
      target: "C:\\Users\\dev\\AppData\\Local\\butler-app\\Butler.exe",
      workingDirectory: "C:\\Users\\dev\\AppData\\Local\\butler-app",
      env: { PSModulePath: "C:\\pwsh-only-modules", Path: "C:\\Windows" },
      runPowerShell: (_executable, args, options) => {
        command = args.at(-1) ?? "";
        environment = options.env;
        return { status: 0 };
      },
    })).toBe(true);
    expect(command).toContain("WScript.Shell");
    expect(command).toContain("GetFolderPath('Programs')");
    expect(JSON.parse(environment.BUTLER_WINDOWS_SHORTCUT_INPUT ?? "{}")).toEqual({
      action: "create",
      name: "Butler.lnk",
      target: "C:\\Users\\dev\\AppData\\Local\\butler-app\\Butler.exe",
      workingDirectory: "C:\\Users\\dev\\AppData\\Local\\butler-app",
    });
    expect(environment.PSModulePath).toBeUndefined();
    expect(environment.Path).toBe("C:\\Windows");
  });

  test("PowerShell child processes reconstruct their native module path", () => {
    expect(windowsPowerShellEnvironment({
      PSModulePath: "C:\\Program Files\\PowerShell\\Modules",
      pSmOdUlEpAtH: "C:\\mixed-case-modules",
      Path: "C:\\Windows",
    })).toEqual({ Path: "C:\\Windows" });
  });

  test("login registration targets the version-independent Squirrel stub", () => {
    expect(windowsLoginItemSettings({
      openAtLogin: true,
      platform: "win32",
      isPackaged: true,
      execPath: "C:\\Users\\dev\\AppData\\Local\\butler-app\\app-0.0.19\\Butler.exe",
    })).toEqual({
      openAtLogin: true,
      path: "C:\\Users\\dev\\AppData\\Local\\butler-app\\Butler.exe",
      args: [],
      name: WINDOWS_APP_USER_MODEL_ID,
    });
  });

  test("update feed is HTTPS in production and loopback-only in tests", () => {
    expect(resolveWindowsUpdateFeedUrl({
      platform: "win32",
      isPackaged: true,
      env: { BUTLER_APP_WINDOWS_UPDATE_FEED_URL: "https://updates.example/butler/win32/x64/" },
    })).toBe("https://updates.example/butler/win32/x64");
    expect(() => resolveWindowsUpdateFeedUrl({
      platform: "win32",
      isPackaged: true,
      env: { BUTLER_APP_WINDOWS_UPDATE_FEED_URL: "http://updates.example/win32" },
    })).toThrow("windows_update_feed_insecure");
    expect(resolveWindowsUpdateFeedUrl({
      platform: "win32",
      isPackaged: true,
      env: {
        BUTLER_APP_WINDOWS_UPDATE_FEED_URL: "http://127.0.0.1:18080/win32",
        BUTLER_APP_WINDOWS_UPDATE_TEST_MODE: "1",
      },
    })).toBe("http://127.0.0.1:18080/win32");
  });

  test("staged installer must match the installed Butler publisher", () => {
    const thumbprint = "A".repeat(40);
    const subject = "CN=Hexpy Games, O=Hexpy Games";
    let environment: NodeJS.ProcessEnv = {};
    expect(verifyWindowsInstallerPublisher({
      currentExecutable: "C:\\installed\\Butler.exe",
      candidateInstaller: "C:\\updates\\ButlerSetup.exe",
      env: { PSModulePath: "C:\\pwsh-only-modules" },
      runPowerShell: (_executable, _args, options) => {
        environment = options.env;
        return {
          status: 0,
          stdout: JSON.stringify([
            { status: "Valid", thumbprint, subject },
            { status: "Valid", thumbprint: "B".repeat(40), subject },
          ]),
        };
      },
    })).toMatchObject({
      status: "Valid",
      signerThumbprint: thumbprint,
      signerSubject: subject,
      publisherConsistent: true,
    });
    expect(environment.PSModulePath).toBeUndefined();
    expect(() => verifyWindowsInstallerPublisher({
      currentExecutable: "C:\\installed\\Butler.exe",
      candidateInstaller: "C:\\updates\\ButlerSetup.exe",
      runPowerShell: () => ({
        status: 0,
        stdout: JSON.stringify([
          { status: "Valid", thumbprint, subject },
          {
            status: "Valid",
            thumbprint: "B".repeat(40),
            subject: "CN=Different Publisher",
          },
        ]),
      }),
    })).toThrow("windows_installer_publisher_mismatch");
  });
});
