import { execFile as nodeExecFile } from "node:child_process";

// Start at login for the Store build: the package's StartupTask. Electron
// has no WinRT access, so the bundled Agent executable reads and switches it.
export function createPackageStartupTask({ agentExecutable, execFile = nodeExecFile }) {
  function run(args) {
    return new Promise((resolve, reject) => {
      execFile(agentExecutable, ["--package-startup-task", ...args],
        { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
          if (error) { reject(error); return; }
          try {
            const { state } = JSON.parse(stdout.trim());
            if (typeof state !== "string") throw new Error("package_startup_task_invalid_state");
            resolve(state === "enabled" || state === "enabled_by_policy");
          } catch (error) { reject(error); }
        });
    });
  }
  return {
    read: () => run([]),
    set: (enabled) => run([enabled ? "enable" : "disable"]),
  };
}
