import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  APP_FOREGROUND_MIGRATION_SCHEMA,
  appForegroundMigrationPath,
  writeAppForegroundMigration,
} from "./app-foreground-lifecycle.mjs";

export const LEGACY_APP_SERVICE_LABELS = Object.freeze([
  "com.hexpy.butler",
  "com.hexpy.butler.menubar-helper",
]);

export function inspectLegacyAppService({
  butlerData,
  platform = process.platform,
  homeDir = homedir(),
  exists = existsSync,
  readJson = defaultReadJson,
} = {}) {
  const plists = platform === "darwin" ? LEGACY_APP_SERVICE_LABELS
    .map((label) => join(homeDir, "Library", "LaunchAgents", `${label}.plist`))
    .filter((path) => exists(path)) : [];
  const systemdUnits = platform === "linux"
    ? [join(homeDir, ".config", "systemd", "user", "butler.service")]
      .filter((path) => exists(path))
    : [];
  const pidFiles = [join(butlerData, "app", "runtime", "menu-bar-helper.pid")]
    .filter((path) => exists(path));
  const serviceStates = readAppOwnedServiceStates(butlerData, { exists, readJson });
  return {
    required: plists.length > 0 || systemdUnits.length > 0 || pidFiles.length > 0 || serviceStates.length > 0,
    plists,
    systemdUnits,
    pidFiles,
    serviceStates,
    detectedArtifacts: [
      ...plists.map(() => "launch_agent"),
      ...systemdUnits.map(() => "systemd_user_service"),
      ...pidFiles.map(() => "helper_pid"),
      ...serviceStates.map(() => "app_service_state"),
    ],
  };
}

export async function migrateLegacyAppService({
  butlerData,
  platform = process.platform,
  homeDir = homedir(),
  uid = process.getuid?.() ?? 0,
  inspect = () => inspectLegacyAppService({ butlerData, homeDir, platform }),
  activeWorkSnapshot = async () => ({ classification: "active_work_unknown" }),
  confirm = async () => false,
  runCommand = defaultRunCommand,
  killProcessGroup = defaultKillProcessGroup,
  isProcessRunning = defaultIsProcessRunning,
  waitForProcessExit = defaultWaitForProcessExit,
  remove = (path) => rmSync(path, { force: true }),
  now = () => new Date(),
} = {}) {
  const completedMigration = defaultReadJson(appForegroundMigrationPath(butlerData));
  if (
    completedMigration?.schema === APP_FOREGROUND_MIGRATION_SCHEMA &&
    completedMigration.status === "complete"
  ) return completedMigration;
  const state = inspect();
  const startedAt = now().toISOString();
  if (!state.required) {
    return writeAppForegroundMigration(butlerData, {
      status: "complete",
      detectedArtifacts: [],
      cleanupSteps: [],
      startedAt,
    }, now);
  }
  const snapshot = await activeWorkSnapshot();
  if (snapshot.classification !== "no_active_work" && !(await confirm(snapshot))) {
    return writeAppForegroundMigration(butlerData, {
      status: "cancelled",
      detectedArtifacts: state.detectedArtifacts,
      activeWorkClassification: snapshot.classification,
      consent: "cancelled",
      cleanupSteps: [],
      startedAt,
    }, now);
  }
  const cleanupSteps = [];
  if (platform === "darwin") {
    for (const label of LEGACY_APP_SERVICE_LABELS) {
      await runCommand("/bin/launchctl", ["bootout", `gui/${uid}/${label}`]);
      cleanupSteps.push({ action: "bootout", label, complete: true });
    }
  } else if (
    platform === "linux" &&
    ((state.systemdUnits?.length ?? 0) > 0 || state.serviceStates.length > 0)
  ) {
    await runCommand("systemctl", ["--user", "disable", "--now", "butler.service"]);
    cleanupSteps.push({ action: "disable_systemd_user_service", complete: true });
  }
  for (const service of state.serviceStates) {
    if (isProcessRunning(service.processGroupId)) {
      killProcessGroup(service.processGroupId, "SIGTERM");
      await waitForProcessExit(service.processGroupId, isProcessRunning);
    }
    if (isProcessRunning(service.processGroupId)) {
      killProcessGroup(service.processGroupId, "SIGKILL");
      await waitForProcessExit(service.processGroupId, isProcessRunning);
    }
    if (isProcessRunning(service.processGroupId)) {
      throw new Error("legacy App service process group is still running");
    }
    remove(service.path);
    cleanupSteps.push({ action: "stop_process_group", complete: true });
  }
  for (const path of [
    ...state.plists,
    ...(state.systemdUnits ?? []),
    ...state.pidFiles,
  ]) remove(path);
  cleanupSteps.push({ action: "remove_user_registration", complete: true });
  return writeAppForegroundMigration(butlerData, {
    status: "complete",
    detectedArtifacts: state.detectedArtifacts,
    activeWorkClassification: snapshot.classification,
    consent: snapshot.classification === "no_active_work" ? "not_required" : "confirmed",
    cleanupSteps,
    startedAt,
  }, now);
}

function readAppOwnedServiceStates(butlerData, { exists, readJson }) {
  const serviceIds = [
    "embed-server",
    "butler-sync-consumer",
    "butler-scheduler",
    "butler-watchdog",
    "butler-main",
    "app-gateway",
  ];
  const result = [];
  for (const serviceId of serviceIds) {
    const path = join(butlerData, "state", "services", `${serviceId}.json`);
    if (!exists(path)) continue;
    const state = readJson(path);
    if (
      state?.supervisor !== "native-supervisor" ||
      state?.runtime?.managedBy !== "butler-app" ||
      !Number.isInteger(state.processGroupId ?? state.pid)
    ) continue;
    result.push({
      path,
      processGroupId: state.processGroupId ?? state.pid,
    });
  }
  return result;
}

function defaultReadJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

async function defaultRunCommand(command, args) {
  await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", resolve);
    child.once("exit", resolve);
  });
}

function defaultKillProcessGroup(processGroupId, signal) {
  try { process.kill(-processGroupId, signal); } catch {
    try { process.kill(processGroupId, signal); } catch {}
  }
}

function defaultIsProcessRunning(processGroupId) {
  try { process.kill(-processGroupId, 0); return true; } catch {
    try { process.kill(processGroupId, 0); return true; } catch { return false; }
  }
}

async function defaultWaitForProcessExit(processGroupId, isRunning, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (isRunning(processGroupId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
