import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  executeWindowsSquirrelLaunch,
  manageWindowsSquirrelShortcut,
  removeWindowsOperationalState,
  resolveWindowsSquirrelLaunch,
  resolveWindowsSquirrelUpdateManifestUrl,
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
    expect(main).toContain("resolveWindowsSquirrelUpdateManifestUrl");
    expect(main).toContain("baseEnv: bundledAgentSupervisorBaseEnv");
    expect(main).toContain("BUTLER_APP_UPDATE_MANIFEST");
    expect(main).toContain("normalInitializationReached: false");
    expect(main).toContain('errorCode: typeof errorCode === "string" ? errorCode : null');
  });

  test("release-cycle cleanup tracks only app processes launched by the smoke", () => {
    const smoke = readFileSync(resolve(
      import.meta.dir,
      "../../packages/butler-app/scripts/windows/windows-squirrel-release-cycle-smoke.ts",
    ), "utf8");
    expect(smoke).toContain("runSquirrelUpdate(outCurrent);");
    expect(smoke).not.toContain("runInstaller(currentSetup);");
    expect(smoke).toContain('process.argv.includes("--prepare-only")');
    expect(smoke).toContain("BUTLER_WINDOWS_RELEASE_PREPARATION_TOKEN");
    expect(smoke).toContain("prepared-releases.json");
    expect(smoke).toContain("loadPreparedLifecycleReleases()");
    expect(smoke).toContain("stopInstalledProcessesAndWait(");
    expect(smoke).toContain('join(systemRoot, "System32", "taskkill.exe")');
    expect(smoke).toContain("spawnSync(taskkillExecutable");
    expect(smoke).toContain("BUTLER_POWERSHELL: powerShellExecutable");
    expect(smoke).toContain("const launchedAppPids = new Set<number>();");
    expect(smoke).toContain("launchedAppPids.add(child.pid)");
    expect(smoke).toContain(".filter((pid) => processAlive(pid))");
    expect(smoke).not.toContain("Get-Process -Name");
    expect(smoke).not.toContain("Get-CimInstance Win32_Process");
    expect(smoke).toContain('"/T"');
    expect(smoke).toContain("remaining=${JSON.stringify(remaining)}");
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
    const smoke = readFileSync(resolve(
      import.meta.dir,
      "../../packages/butler-app/scripts/windows/windows-squirrel-release-cycle-smoke.ts",
    ), "utf8");
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
    const uninstall = smoke.indexOf("  runOwnedAppUninstaller();");
    const evidence = smoke.indexOf(
      '  const uninstallEvidence = await requireSuccessfulSquirrelEvidence("uninstall");',
      uninstall,
    );
    const forcedCleanup = smoke.indexOf("  removeOwnedInstallRoot();", evidence);
    expect(uninstall).toBeGreaterThan(0);
    expect(evidence).toBeGreaterThan(uninstall);
    expect(forcedCleanup).toBeGreaterThan(evidence);
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
    let timeout = 0;
    expect(manageWindowsSquirrelShortcut({
      action: "create",
      name: "Butler.lnk",
      target: "C:\\Users\\dev\\AppData\\Local\\butler-app\\Butler.exe",
      workingDirectory: "C:\\Users\\dev\\AppData\\Local\\butler-app",
      env: { PSModulePath: "C:\\pwsh-only-modules", Path: "C:\\Windows" },
      runPowerShell: (_executable, args, options) => {
        command = args.at(-1) ?? "";
        environment = options.env;
        timeout = Number(options.timeout);
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
    expect(timeout).toBe(5_000);
  });

  test("uninstall removes the Start Menu shortcut without launching PowerShell", () => {
    const removed: string[] = [];
    expect(manageWindowsSquirrelShortcut({
      action: "remove",
      name: "Butler.lnk",
      target: "C:\\Users\\dev\\AppData\\Local\\butler-app\\Butler.exe",
      workingDirectory: "C:\\Users\\dev\\AppData\\Local\\butler-app",
      env: { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
      runPowerShell: () => {
        throw new Error("PowerShell must not run during uninstall shortcut cleanup");
      },
      removePath: (path) => removed.push(path),
      pathExists: () => false,
    })).toBe(true);
    expect(removed).toEqual([
      "C:\\Users\\dev\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Butler.lnk",
    ]);
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

  test("GitHub update manifest is selected only for the packaged Squirrel layout", () => {
    const squirrelPath =
      "C:\\Users\\dev\\AppData\\Local\\butler-app\\app-0.0.19\\Butler.exe";
    expect(resolveWindowsSquirrelUpdateManifestUrl({
      platform: "win32",
      isPackaged: true,
      execPath: squirrelPath,
      env: {},
    })).toBe(
      "https://github.com/Hexpy-Games/butler/releases/latest/download/windows-app-update-manifest.json",
    );
    expect(resolveWindowsSquirrelUpdateManifestUrl({
      platform: "win32",
      isPackaged: true,
      execPath: "C:\\Program Files\\WindowsApps\\Butler_0.0.19\\Butler.exe",
      env: {},
    })).toBeNull();
    expect(resolveWindowsSquirrelUpdateManifestUrl({
      platform: "win32",
      isPackaged: true,
      execPath: squirrelPath,
      env: { BUTLER_APP_UPDATE_MANIFEST: "https://updates.example/custom.json" },
    })).toBe("https://updates.example/custom.json");
    expect(resolveWindowsSquirrelUpdateManifestUrl({
      platform: "win32",
      isPackaged: true,
      execPath: squirrelPath,
      env: {
        BUTLER_APP_UPDATE_MANIFEST: "https://updates.example/app.json",
        BUTLER_UPDATE_MANIFEST: "https://updates.example/generic.json",
      },
    })).toBe("https://updates.example/app.json");
    expect(resolveWindowsSquirrelUpdateManifestUrl({
      platform: "win32",
      isPackaged: true,
      execPath: "C:\\Users\\dev\\AppData\\Local\\butler-app\\app-dev\\Butler.exe",
      env: {},
    })).toBeNull();
    expect(resolveWindowsSquirrelUpdateManifestUrl({
      platform: "win32",
      isPackaged: true,
      execPath: "butler-app\\app-0.0.19\\Butler.exe",
      env: {},
    })).toBeNull();
    expect(resolveWindowsSquirrelUpdateManifestUrl({
      platform: "win32",
      isPackaged: false,
      execPath: squirrelPath,
      env: {},
    })).toBeNull();
  });

  test("staged installer must match the installed Butler publisher", () => {
    const lifecycle = readFileSync(resolve(
      import.meta.dir,
      "../../packages/butler-app/client/electron/windows-squirrel-lifecycle.mjs",
    ), "utf8");
    expect(lifecycle).toContain("X509Chain");
    expect(lifecycle).toContain("X509RevocationMode");
    expect(lifecycle).toContain("X509VerificationFlags");
    expect(lifecycle).toContain("chainStatus");
    expect(lifecycle).toContain("UntrustedRoot");
    const thumbprint = "A".repeat(40);
    const subject = "CN=Hexpy Games, O=Hexpy Games";
    let environment: NodeJS.ProcessEnv = {};
    expect(verifyWindowsInstallerPublisher({
      currentExecutable: "C:\\installed\\Butler.exe",
      candidateInstaller: "C:\\updates\\ButlerSetup.exe",
      env: {
        PSModulePath: "C:\\pwsh-only-modules",
        WINDOWS_COMMUNITY_CERTIFICATE_PFX: "private-pfx",
        WINDOWS_COMMUNITY_CERTIFICATE_PASSWORD: "private-password",
        BUTLER_WINDOWS_SIGN_CERTIFICATE_PASSWORD: "private-password",
      },
      runPowerShell: (_executable, _args, options) => {
        environment = options.env;
        return {
          status: 0,
          stdout: JSON.stringify([
            { status: "Valid", thumbprint, subject, chainStatus: [] },
            {
              status: "Valid",
              thumbprint: "B".repeat(40),
              subject,
              chainStatus: [],
            },
          ]),
        };
      },
    })).toMatchObject({
      status: "Valid",
      signerThumbprint: thumbprint,
      signerSubject: subject,
      publisherConsistent: true,
      acceptanceMode: "public-trust",
    });
    expect(environment.PSModulePath).toBeUndefined();
    expect(environment.WINDOWS_COMMUNITY_CERTIFICATE_PFX).toBeUndefined();
    expect(environment.WINDOWS_COMMUNITY_CERTIFICATE_PASSWORD).toBeUndefined();
    expect(environment.BUTLER_WINDOWS_SIGN_CERTIFICATE_PASSWORD).toBeUndefined();
    expect(() => verifyWindowsInstallerPublisher({
      currentExecutable: "C:\\installed\\Butler.exe",
      candidateInstaller: "C:\\updates\\ButlerSetup.exe",
      runPowerShell: () => ({
        status: 0,
        stdout: JSON.stringify([
          { status: "Valid", thumbprint, subject, chainStatus: [] },
          {
            status: "Valid",
            thumbprint: "B".repeat(40),
            subject: "CN=Different Publisher",
            chainStatus: [],
          },
        ]),
      }),
    })).toThrow("windows_installer_publisher_mismatch");
    expect(verifyWindowsInstallerPublisher({
      currentExecutable: "C:\\installed\\Butler.exe",
      candidateInstaller: "C:\\updates\\ButlerSetup.exe",
      runPowerShell: () => ({
        status: 0,
        stdout: JSON.stringify([
          {
            status: "UnknownError",
            thumbprint,
            subject,
            chainStatus: ["UntrustedRoot"],
          },
          {
            status: "UnknownError",
            thumbprint,
            subject,
            chainStatus: ["UntrustedRoot"],
          },
        ]),
      }),
    })).toMatchObject({
      status: "UnknownError",
      acceptanceMode: "community",
      signerThumbprint: thumbprint,
      signerSubject: subject,
    });
    expect(() => verifyWindowsInstallerPublisher({
      currentExecutable: "C:\\installed\\Butler.exe",
      candidateInstaller: "C:\\updates\\ButlerSetup.exe",
      runPowerShell: () => ({
        status: 0,
        stdout: JSON.stringify([
          {
            status: "UnknownError",
            thumbprint,
            subject,
            chainStatus: ["UntrustedRoot"],
          },
          {
            status: "UnknownError",
            thumbprint: "B".repeat(40),
            subject,
            chainStatus: ["UntrustedRoot"],
          },
        ]),
      }),
    })).toThrow("windows_installer_certificate_mismatch");
    expect(() => verifyWindowsInstallerPublisher({
      currentExecutable: "C:\\installed\\Butler.exe",
      candidateInstaller: "C:\\updates\\ButlerSetup.exe",
      runPowerShell: () => ({
        status: 0,
        stdout: JSON.stringify([
          {
            status: "NotTrusted",
            thumbprint,
            subject,
            chainStatus: ["UntrustedRoot"],
          },
          {
            status: "NotTrusted",
            thumbprint,
            subject,
            chainStatus: ["UntrustedRoot"],
          },
        ]),
      }),
    })).toThrow("windows_installer_signature_invalid");
    for (const status of ["NotSigned", "HashMismatch", "NotSupported", "Incompatible"]) {
      expect(() => verifyWindowsInstallerPublisher({
        currentExecutable: "C:\\installed\\Butler.exe",
        candidateInstaller: "C:\\updates\\ButlerSetup.exe",
        runPowerShell: () => ({
          status: 0,
          stdout: JSON.stringify([
            { status, thumbprint, subject, chainStatus: [] },
            { status, thumbprint, subject, chainStatus: [] },
          ]),
        }),
      })).toThrow("windows_installer_signature_invalid");
    }
    for (const chainStatus of [
      ["PartialChain"],
      ["UntrustedRoot", "RevocationStatusUnknown"],
    ]) {
      expect(() => verifyWindowsInstallerPublisher({
        currentExecutable: "C:\\installed\\Butler.exe",
        candidateInstaller: "C:\\updates\\ButlerSetup.exe",
        runPowerShell: () => ({
          status: 0,
          stdout: JSON.stringify([
            { status: "UnknownError", thumbprint, subject, chainStatus },
            { status: "UnknownError", thumbprint, subject, chainStatus },
          ]),
        }),
      })).toThrow("windows_installer_signature_invalid");
    }
    expect(() => verifyWindowsInstallerPublisher({
      currentExecutable: "C:\\installed\\Butler.exe",
      candidateInstaller: "C:\\updates\\ButlerSetup.exe",
      runPowerShell: () => ({
        status: 0,
        stdout: JSON.stringify([
          { status: "UnknownError", thumbprint, subject, chainStatus: ["UntrustedRoot"] },
          { status: "Valid", thumbprint, subject, chainStatus: [] },
        ]),
      }),
    })).toThrow("windows_installer_signature_invalid");
    expect(() => verifyWindowsInstallerPublisher({
      currentExecutable: "C:\\installed\\Butler.exe",
      candidateInstaller: "C:\\updates\\ButlerSetup.exe",
      runPowerShell: () => ({
        status: 0,
        stdout: JSON.stringify([
          { status: "UnknownError", thumbprint, subject },
          { status: "UnknownError", thumbprint, subject, chainStatus: ["UntrustedRoot"] },
        ]),
      }),
    })).toThrow("windows_installer_signature_invalid");
    expect(() => verifyWindowsInstallerPublisher({
      currentExecutable: "C:\\installed\\Butler.exe",
      candidateInstaller: "C:\\updates\\ButlerSetup.exe",
      runPowerShell: () => ({ status: 0, stdout: "null" }),
    })).toThrow("windows_installer_signature_result_invalid");
  });
});
