import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const SESSION_FOLDER_TARGET_KEYS = Object.freeze([
  "vscode",
  "terminal",
]);

const SESSION_FOLDER_CODES = Object.freeze({
  unavailable: "session_workspace_unavailable",
  targetUnavailable: "launch_target_unavailable",
  launchFailed: "session_folder_launch_failed",
});

export function createSessionFolderLauncher({
  platform = process.platform,
  resolveWorkspacePath,
  isDirectory = defaultIsDirectory,
  isApplicationAvailable = defaultIsApplicationAvailable,
  launchApplication = defaultLaunchApplication,
} = {}) {
  async function availableTargets(sessionId) {
    const workspacePath = await existingWorkspacePath(sessionId);
    if (!workspacePath) return unavailableTargets();

    const targets = SESSION_FOLDER_TARGET_KEYS.filter((target) => {
      const launch = launchSpec(platform, target, workspacePath);
      return launch && isApplicationAvailable(launch.application);
    });
    return { ok: true, targets };
  }

  async function openSessionFolder({ sessionId, target } = {}) {
    const normalizedTarget = normalizeTarget(target);
    if (!normalizedTarget) return failure(SESSION_FOLDER_CODES.targetUnavailable);

    const workspacePath = await existingWorkspacePath(sessionId);
    if (!workspacePath) return failure(SESSION_FOLDER_CODES.unavailable);

    const launch = launchSpec(platform, normalizedTarget, workspacePath);
    if (!launch || !isApplicationAvailable(launch.application)) {
      return failure(SESSION_FOLDER_CODES.targetUnavailable);
    }
    try {
      const result = launchApplication(launch.command, launch.args);
      if (!result?.ok) return failure(SESSION_FOLDER_CODES.launchFailed);
      return { ok: true, target: normalizedTarget };
    } catch {
      return failure(SESSION_FOLDER_CODES.launchFailed);
    }
  }

  async function existingWorkspacePath(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId || typeof resolveWorkspacePath !== "function") {
      return null;
    }
    try {
      const workspacePath = await resolveWorkspacePath(normalizedSessionId);
      if (!isAbsoluteWorkspacePath(workspacePath)) return null;
      return await isDirectory(workspacePath) ? workspacePath : null;
    } catch {
      return null;
    }
  }

  return { availableTargets, openSessionFolder };
}

function normalizeSessionId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeTarget(value) {
  return typeof value === "string" && SESSION_FOLDER_TARGET_KEYS.includes(value)
    ? value
    : null;
}

function isAbsoluteWorkspacePath(value) {
  return typeof value === "string" && value.trim() && isAbsolute(value);
}

function launchSpec(platform, target, workspacePath) {
  if (platform !== "darwin") return null;
  const application = target === "vscode" ? "Visual Studio Code" : "Terminal";
  return {
    application,
    command: "open",
    args: ["-a", application, workspacePath],
  };
}

async function defaultIsDirectory(workspacePath) {
  try {
    return (await stat(workspacePath)).isDirectory();
  } catch {
    return false;
  }
}

function defaultIsApplicationAvailable(application) {
  try {
    const result = spawnSync("open", ["-Ra", application], {
      shell: false,
      stdio: "ignore",
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function defaultLaunchApplication(command, args) {
  try {
    const result = spawnSync(command, args, {
      shell: false,
      stdio: "ignore",
    });
    return { ok: !result.error && result.status === 0 };
  } catch {
    return { ok: false };
  }
}

function unavailableTargets() {
  return {
    ok: false,
    code: SESSION_FOLDER_CODES.unavailable,
    recoverable: true,
    targets: [],
  };
}

function failure(code) {
  return { ok: false, code, recoverable: true };
}
