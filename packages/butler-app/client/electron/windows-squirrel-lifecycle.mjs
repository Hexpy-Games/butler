import { rmSync } from "node:fs";
import { basename, win32 } from "node:path";

export const WINDOWS_SQUIRREL_PACKAGE_ID = "butler-app";
export const WINDOWS_SQUIRREL_EXE_NAME = "Butler.exe";
export const WINDOWS_APP_USER_MODEL_ID =
  `com.squirrel.${WINDOWS_SQUIRREL_PACKAGE_ID}.Butler`;
export const WINDOWS_APP_PROTOCOL = "butler";
export const WINDOWS_SQUIRREL_FIRST_RUN_UPDATE_DELAY_MS = 10_000;

const squirrelLifecycleEvents = new Set([
  "--squirrel-install",
  "--squirrel-updated",
  "--squirrel-uninstall",
  "--squirrel-obsolete",
]);

export function resolveWindowsSquirrelLaunch({
  platform = process.platform,
  argv = process.argv,
  execPath = process.execPath,
} = {}) {
  const firstRun = platform === "win32" && argv.includes("--squirrel-firstrun");
  if (platform !== "win32") return unhandledSquirrelLaunch({ firstRun: false });
  const event = argv.find((value) => squirrelLifecycleEvents.has(value));
  if (!event) return unhandledSquirrelLaunch({ firstRun });

  const appFolder = win32.dirname(execPath);
  const squirrelRoot = win32.resolve(appFolder, "..");
  const exeName = win32.basename(execPath) || WINDOWS_SQUIRREL_EXE_NAME;
  const shortcutAction = event === "--squirrel-install" || event === "--squirrel-updated"
    ? "create"
    : event === "--squirrel-uninstall"
      ? "remove"
      : null;
  return {
    handled: true,
    firstRun: false,
    event,
    shortcutAction,
    stubLauncher: win32.join(squirrelRoot, exeName),
    shortcutName: "Butler.lnk",
    shortcutWorkingDirectory: squirrelRoot,
    appUserModelId: WINDOWS_APP_USER_MODEL_ID,
    protocol: WINDOWS_APP_PROTOCOL,
    removeOperationalState: event === "--squirrel-uninstall",
    registerProtocol: shortcutAction === "create",
    unregisterProtocol: shortcutAction === "remove",
    rawTextIncluded: false,
  };
}

export function windowsLoginItemSettings({
  openAtLogin,
  platform = process.platform,
  isPackaged = false,
  execPath = process.execPath,
} = {}) {
  if (platform !== "win32" || !isPackaged) {
    return {
      openAtLogin: openAtLogin === true,
      openAsHidden: true,
    };
  }
  const appFolder = win32.dirname(execPath);
  return {
    openAtLogin: openAtLogin === true,
    path: win32.resolve(appFolder, "..", win32.basename(execPath)),
    args: [],
    name: WINDOWS_APP_USER_MODEL_ID,
  };
}

export function windowsOperationalCleanupPaths(butlerData) {
  return [
    win32.join(butlerData, "app", "runtime"),
    win32.join(butlerData, "updates"),
  ];
}

export function removeWindowsOperationalState({
  butlerData,
  removePath = (path) => rmSync(path, {
    force: true,
    maxRetries: 4,
    recursive: true,
    retryDelay: 125,
  }),
} = {}) {
  const removed = [];
  for (const path of windowsOperationalCleanupPaths(butlerData)) {
    removePath(path);
    removed.push(path);
  }
  return removed;
}

export function executeWindowsSquirrelLaunch(plan, {
  manageShortcut,
  setLoginItemSettings = () => {},
  registerProtocol = () => true,
  unregisterProtocol = () => true,
  cleanupOperationalState = () => [],
} = {}) {
  if (!plan?.handled) return { handled: false, event: null };
  if (plan.removeOperationalState) {
    setLoginItemSettings({
      openAtLogin: false,
      path: plan.stubLauncher,
      args: [],
      name: plan.appUserModelId,
    });
    if (unregisterProtocol(plan.protocol, plan.stubLauncher, []) === false) {
      throw windowsSquirrelError("windows_squirrel_protocol_unregister_failed");
    }
    cleanupOperationalState();
  } else if (plan.registerProtocol) {
    if (registerProtocol(plan.protocol, plan.stubLauncher, []) === false) {
      throw windowsSquirrelError("windows_squirrel_protocol_register_failed");
    }
  }

  if (plan.shortcutAction) {
    if (typeof manageShortcut !== "function") {
      throw windowsSquirrelError("windows_squirrel_shortcut_runner_missing");
    }
    if (manageShortcut({
      action: plan.shortcutAction,
      name: plan.shortcutName,
      target: plan.stubLauncher,
      workingDirectory: plan.shortcutWorkingDirectory,
    }) === false) {
      throw windowsSquirrelError("windows_squirrel_shortcut_failed");
    }
  }
  return {
    handled: true,
    event: plan.event,
    shortcutAction: plan.shortcutAction,
    operationalStateRemoved: plan.removeOperationalState,
  };
}

export function manageWindowsSquirrelShortcut({
  action,
  name,
  target,
  workingDirectory,
  runPowerShell,
  env = process.env,
} = {}) {
  if (!["create", "remove"].includes(action) ||
    typeof name !== "string" || !name.endsWith(".lnk") ||
    typeof target !== "string" || !target ||
    typeof workingDirectory !== "string" || !workingDirectory ||
    typeof runPowerShell !== "function") {
    throw windowsSquirrelError("windows_squirrel_shortcut_input_invalid");
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$input = ConvertFrom-Json $env:BUTLER_WINDOWS_SHORTCUT_INPUT",
    "$programs = [Environment]::GetFolderPath('Programs')",
    "if (-not $programs) { throw 'programs_folder_unavailable' }",
    "$shortcutPath = Join-Path $programs ([string]$input.name)",
    "if ([string]$input.action -eq 'remove') {",
    "  Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue",
    "  if (Test-Path -LiteralPath $shortcutPath) { throw 'shortcut_remove_failed' }",
    "} else {",
    "  New-Item -ItemType Directory -Path $programs -Force | Out-Null",
    "  $shell = New-Object -ComObject WScript.Shell",
    "  $shortcut = $shell.CreateShortcut($shortcutPath)",
    "  $shortcut.TargetPath = [string]$input.target",
    "  $shortcut.WorkingDirectory = [string]$input.workingDirectory",
    "  $shortcut.IconLocation = ([string]$input.target + ',0')",
    "  $shortcut.Description = 'Butler'",
    "  $shortcut.Save()",
    "  if (-not (Test-Path -LiteralPath $shortcutPath)) { throw 'shortcut_create_failed' }",
    "}",
  ].join("; ");
  const result = runPowerShell(env.BUTLER_POWERSHELL || "powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    env: {
      ...env,
      BUTLER_WINDOWS_SHORTCUT_INPUT: JSON.stringify({
        action,
        name,
        target,
        workingDirectory,
      }),
    },
    shell: false,
    timeout: 12_000,
    windowsHide: true,
  });
  if (result?.status !== 0) {
    throw windowsSquirrelError("windows_squirrel_shortcut_failed");
  }
  return true;
}

export function resolveWindowsUpdateFeedUrl({
  platform = process.platform,
  isPackaged = false,
  env = process.env,
} = {}) {
  if (platform !== "win32" || !isPackaged) return null;
  const value = env.BUTLER_APP_WINDOWS_UPDATE_FEED_URL?.trim();
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw windowsSquirrelError("windows_update_feed_invalid");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw windowsSquirrelError("windows_update_feed_invalid");
  }
  const loopbackTestFeed = env.BUTLER_APP_WINDOWS_UPDATE_TEST_MODE === "1" &&
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopbackTestFeed) {
    throw windowsSquirrelError("windows_update_feed_insecure");
  }
  if (basename(url.pathname).toLocaleUpperCase("en-US") === "RELEASES") {
    throw windowsSquirrelError("windows_update_feed_must_be_directory");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

export function shouldDelayWindowsFirstUpdateCheck({
  platform = process.platform,
  argv = process.argv,
} = {}) {
  return platform === "win32" && argv.includes("--squirrel-firstrun");
}

export function verifyWindowsInstallerPublisher({
  currentExecutable,
  candidateInstaller,
  runPowerShell,
  env = process.env,
} = {}) {
  if (typeof runPowerShell !== "function") {
    throw windowsSquirrelError("windows_installer_signature_runner_missing");
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$paths = ConvertFrom-Json $env:BUTLER_WINDOWS_INSTALLER_SIGNATURE_PATHS",
    "$result = foreach ($path in $paths) {",
    "  $signature = Get-AuthenticodeSignature -LiteralPath ([string]$path)",
    "  [pscustomobject]@{ status = [string]$signature.Status; thumbprint = [string]$signature.SignerCertificate.Thumbprint; subject = [string]$signature.SignerCertificate.Subject }",
    "}",
    "ConvertTo-Json -Compress -InputObject @($result)",
  ].join("; ");
  const result = runPowerShell(env.BUTLER_POWERSHELL || "powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    env: {
      ...env,
      BUTLER_WINDOWS_INSTALLER_SIGNATURE_PATHS: JSON.stringify([
        currentExecutable,
        candidateInstaller,
      ]),
    },
    shell: false,
    timeout: 15_000,
    windowsHide: true,
  });
  if (result?.status !== 0) {
    throw windowsSquirrelError("windows_installer_signature_check_failed");
  }
  let signatures;
  try {
    signatures = JSON.parse(String(result.stdout ?? "").trim());
  } catch {
    throw windowsSquirrelError("windows_installer_signature_result_invalid");
  }
  if (!Array.isArray(signatures) || signatures.length !== 2) {
    throw windowsSquirrelError("windows_installer_signature_result_invalid");
  }
  const normalized = signatures.map((signature) => ({
    status: String(signature?.status ?? ""),
    thumbprint: String(signature?.thumbprint ?? "").toLocaleUpperCase("en-US"),
    subject: String(signature?.subject ?? "").normalize("NFKC").trim(),
  }));
  if (normalized.some((signature) =>
    signature.status !== "Valid" ||
    !/^[A-F0-9]{40}$/u.test(signature.thumbprint) ||
    !signature.subject,
  )) {
    throw windowsSquirrelError("windows_installer_signature_invalid");
  }
  if (normalized[0].subject !== normalized[1].subject) {
    throw windowsSquirrelError("windows_installer_publisher_mismatch");
  }
  return {
    status: "Valid",
    signerThumbprint: normalized[0].thumbprint,
    signerSubject: normalized[0].subject,
    publisherConsistent: true,
    rawTextIncluded: false,
  };
}

function unhandledSquirrelLaunch({ firstRun }) {
  return {
    handled: false,
    firstRun,
    event: null,
    rawTextIncluded: false,
  };
}

function windowsSquirrelError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
