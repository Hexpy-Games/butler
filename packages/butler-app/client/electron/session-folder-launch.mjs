import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

export const SESSION_FOLDER_TARGET_KEYS = Object.freeze([
  "vscode",
  "terminal",
  "fileManager",
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
  resolveCommand = defaultResolveCommand,
  launchApplication = defaultLaunchApplication,
} = {}) {
  async function availableTargets(sessionId) {
    const workspacePath = await existingWorkspacePath(sessionId);
    if (!workspacePath) return unavailableTargets();

    const targets = SESSION_FOLDER_TARGET_KEYS.filter((target) => {
      return launchSpec(platform, target, workspacePath, {
        isApplicationAvailable,
        resolveCommand,
      }) !== null;
    });
    return { ok: true, targets };
  }

  async function openSessionFolder({ sessionId, target } = {}) {
    const normalizedTarget = normalizeTarget(target);
    if (!normalizedTarget) return failure(SESSION_FOLDER_CODES.targetUnavailable);

    const workspacePath = await existingWorkspacePath(sessionId);
    if (!workspacePath) return failure(SESSION_FOLDER_CODES.unavailable);

    const launch = launchSpec(platform, normalizedTarget, workspacePath, {
      isApplicationAvailable,
      resolveCommand,
    });
    if (!launch) {
      return failure(SESSION_FOLDER_CODES.targetUnavailable);
    }
    try {
      const result = await launchApplication(
        launch.command,
        launch.args,
        launch.options,
      );
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
  return typeof value === "string" && value.trim() && path.isAbsolute(value);
}

export function buildSessionFolderLaunchSpec(
  platform,
  target,
  workspacePath,
  resolveCommand = (command) => command,
) {
  if (!SESSION_FOLDER_TARGET_KEYS.includes(target)) return null;
  if (platform === "darwin") return darwinLaunchSpec(target, workspacePath);
  if (platform === "win32") {
    return windowsLaunchSpec(target, workspacePath, resolveCommand);
  }
  if (platform === "linux") return linuxLaunchSpec(target, workspacePath, resolveCommand);
  return null;
}

function darwinLaunchSpec(target, workspacePath) {
  const application = target === "vscode"
    ? "Visual Studio Code"
    : target === "terminal"
      ? "Terminal"
      : "Finder";
  return {
    application,
    command: "open",
    args: ["-a", application, workspacePath],
  };
}

function windowsLaunchSpec(target, workspacePath, resolveCommand) {
  if (target === "fileManager") {
    return commandSpec(resolveCommand, "explorer.exe", [workspacePath]);
  }
  if (target === "terminal") {
    const windowsTerminal = resolveCommand("wt.exe");
    if (windowsTerminal) {
      return { command: windowsTerminal, args: ["-d", workspacePath] };
    }
    const commandPrompt = resolveCommand("cmd.exe");
    return commandPrompt
      ? {
          command: commandPrompt,
          args: ["/c", "start", "", "/D", workspacePath, "cmd.exe"],
        }
      : null;
  }
  if (target === "vscode") {
    const codeCommand = resolveCommand("code.cmd");
    const commandPrompt = resolveCommand("cmd.exe");
    return codeCommand && commandPrompt
      ? {
          command: commandPrompt,
          args: ["/d", "/s", "/c", "call", codeCommand, workspacePath],
        }
      : null;
  }
  return null;
}

function linuxLaunchSpec(target, workspacePath, resolveCommand) {
  if (target === "fileManager") {
    return commandSpec(resolveCommand, "xdg-open", [workspacePath]);
  }
  if (target === "terminal") {
    const terminal = resolveCommand("x-terminal-emulator");
    if (terminal) {
      return {
        command: terminal,
        args: [],
        options: { cwd: workspacePath },
      };
    }
    const gnomeTerminal = resolveCommand("gnome-terminal");
    if (gnomeTerminal) {
      return {
        command: gnomeTerminal,
        args: ["--working-directory", workspacePath],
      };
    }
    const konsole = resolveCommand("konsole");
    return konsole
      ? { command: konsole, args: ["--workdir", workspacePath] }
      : null;
  }
  if (target === "vscode") {
    return commandSpec(resolveCommand, "code", [workspacePath]);
  }
  return null;
}

function commandSpec(resolveCommand, name, args) {
  const command = resolveCommand(name);
  return command ? { command, args } : null;
}

function launchSpec(platform, target, workspacePath, dependencies) {
  const launch = buildSessionFolderLaunchSpec(
    platform,
    target,
    workspacePath,
    dependencies.resolveCommand,
  );
  if (!launch) return null;
  if (
    platform === "darwin" &&
    !dependencies.isApplicationAvailable(launch.application)
  ) {
    return null;
  }
  return launch;
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

function defaultResolveCommand(command) {
  const platform = process.platform;
  const pathModule = platform === "win32" ? path.win32 : path;
  const pathValue = Object.entries(process.env).find(([name]) =>
    name.toLowerCase() === "path"
  )?.[1];
  if (!pathValue) return null;

  const pathEntries = pathValue.split(platform === "win32" ? ";" : path.delimiter);
  const extensions = platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean)
    : [""];
  const names = platform === "win32" && !pathModule.extname(command)
    ? extensions.map((extension) => `${command}${extension}`)
    : [command];

  for (const entry of pathEntries) {
    for (const name of names) {
      const candidate = pathModule.join(entry, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (platform !== "win32") accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep looking through PATH entries and platform extensions.
      }
    }
  }
  return null;
}

function defaultLaunchApplication(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        ...options,
        shell: false,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve({ ok: false });
      return;
    }
    child.once("error", () => resolve({ ok: false }));
    child.once("spawn", () => {
      child.unref();
      resolve({ ok: true });
    });
  });
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
