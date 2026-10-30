import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ownedProcesses, readJson, waitFor, waitForOwnedExit, type OwnedProcesses } from "./installer-smoke-support.ts";

/** Launch the installed Squirrel stub directly: it forwards argv to Electron. */
export function launchInstalledApp(executable: string, port: number, env: Record<string, string>, owned: OwnedProcesses) {
  // Port 0 survives updates whose helper may inherit the previous listening socket.
  return spawnInstalledApp(executable, [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"], env, owned);
}

/** Setup auto-launch cannot carry Chromium argv. Observe it, quit, then launch directly. */
export async function relaunchInstalledAppForDebugging(executable: string, port: number, env: Record<string, string>, owned: OwnedProcesses) {
  const runtime = join(env.BUTLER_DATA, "app/runtime/foreground");
  try {
    await waitFor(() => {
      const instance = readJson(join(runtime, "instance.json"));
      const progress = readJson(join(runtime, "startup-progress.json"));
      return Boolean(instance?.app_pid) && instance?.state === "ready" && progress?.tray_ready === true;
    }, "Setup auto-launch ready with tray");
  } catch (error) {
    dumpStartupEvidence([join(runtime, "startup-progress.json"), appStdioLog(env)]);
    throw error;
  }
  ownedProcesses(env.BUTLER_DATA, owned);
  spawnInstalledApp(executable, ["--butler-quit-main-ui"], env, owned);
  await waitForOwnedExit(owned, "Setup auto-launched App and Agent quit", () => ownedProcesses(env.BUTLER_DATA, owned));
  return launchInstalledApp(executable, port, env, owned);
}

/** Print each startup file as written, or say that it is missing. */
function dumpStartupEvidence(paths: string[]) {
  for (const path of paths) {
    console.error(existsSync(path) ? `${path}:\n${readFileSync(path, "utf8")}` : `${path}: missing`);
  }
}

function appStdioLog(env: Record<string, string>) {
  return join(dirname(env.BUTLER_APP_ELECTRON_USER_DATA_DIR), "app-stdio.log");
}

function spawnInstalledApp(executable: string, args: string[], env: Record<string, string>, owned: OwnedProcesses) {
  const log = openSync(appStdioLog(env), "a");
  try {
    const child = spawn(executable, args, { env, stdio: ["ignore", log, log] });
    const notAfter = Date.now();
    assert.ok(child.pid, "Installed App did not spawn");
    owned.set(child.pid, { notAfter });
    return child;
  } finally { closeSync(log); }
}
