import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromiumLaunchArgs } from "../../packages/butler-app/client/electron/butler-platform/chromium-features.mjs";

import { killOwnedProcessGroup, ownedProcessGroupAlive } from "../../packages/butler-app/client/electron/butler-platform/process-group.mjs";

type OwnedElectron = { child: ChildProcess; paths: string[]; stop?: Promise<void> };
const children = new Map<ChildProcess, OwnedElectron>();
function killOwnedChildren(): void {
  for (const entry of children.values()) {
    if (entry.child.pid) killOwnedProcessGroup(entry.child.pid);
    for (const path of entry.paths) rmSync(path, { recursive: true, force: true });
  }
  children.clear();
}
process.once("exit", killOwnedChildren);
process.on("uncaughtExceptionMonitor", killOwnedChildren);
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.once(signal, () => { killOwnedChildren(); process.exit(code); });
}

/**
 * The caller must spawn detached; even the deliberately piped EPIPE smoke.
 * `relaunches`: the App may relaunch itself (Electron's relauncher stays in this group and starts
 * the successor after the leader exits), so the group outlives its leader until stopElectronChild.
 */
export function trackElectronChild(child: ChildProcess, paths: string[] = [], relaunches = false): ChildProcess {
  const entry = { child, paths };
  children.set(child, entry);
  // Kill helpers while this leader's process group still belongs to us.
  if (!relaunches) child.once("exit", () => { if (child.pid) killOwnedProcessGroup(child.pid); });
  child.once("error", () => { if (!child.pid) {
    for (const path of paths) rmSync(path, { recursive: true, force: true });
    children.delete(child);
  } });
  return child;
}

/** File-backed diagnostics survive harness exit without a dangling pipe reader. */
export function spawnElectron(
  command: string, args: string[], options: Omit<SpawnOptions, "detached"> & { onOutput?: (bytes: Buffer) => void; cleanupPaths?: string[]; relaunches?: boolean },
): ChildProcess {
  const { onOutput: output = () => {}, cleanupPaths, relaunches = false, ...spawnOptions } = options;
  const profileArg = args.find(arg => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
  const profile = profileArg || options.env?.BUTLER_APP_ELECTRON_USER_DATA_DIR || mkdtempSync(join(tmpdir(), "butler-electron-profile-"));
  const paths = cleanupPaths ?? [profile];
  const dir = mkdtempSync(join(tmpdir(), "butler-electron-log-"));
  const file = join(dir, "stdio.log");
  const writer = openSync(file, "a"), reader = openSync(file, "r");
  let offset = 0;
  const drain = () => {
    const buffer = Buffer.alloc(64 * 1024);
    let count: number;
    while ((count = readSync(reader, buffer, 0, buffer.length, offset)) > 0) {
      offset += count; output(Buffer.from(buffer.subarray(0, count)));
    }
  };
  const watcher = watch(file, drain);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true; watcher.close(); drain(); closeSync(reader);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const child = trackElectronChild(spawn(command, chromiumLaunchArgs(args), { ...spawnOptions, detached: true, env: { ...(options.env ?? process.env), BUTLER_APP_ELECTRON_USER_DATA_DIR: profile }, stdio: ["ignore", writer, writer] }), paths, relaunches);
    child.once("exit", drain);
    child.once("close", cleanup);
    return child;
  } catch (error) { cleanup(); for (const path of paths) rmSync(path, { recursive: true, force: true }); throw error; }
  finally { closeSync(writer); }
}

/** Harness teardown bypasses product quit: a dead gateway must never strand it. */
export async function stopElectronChild(child: ChildProcess): Promise<void> {
  const entry = children.get(child);
  if (!entry) return;
  entry.stop ??= (async () => {
    if (child.pid) {
      killOwnedProcessGroup(child.pid);
      const deadline = Date.now() + 5000;
      while (ownedProcessGroupAlive(child.pid)) {
        if (Date.now() >= deadline) throw new Error(`Owned Electron group ${child.pid} did not exit`);
        await new Promise(done => setTimeout(done, 20));
      }
    }
    for (const path of entry.paths) rmSync(path, { recursive: true, force: true });
    children.delete(child);
  })();
  await entry.stop;
}

/** Prefer this scope for new real-App smokes; exit hooks cover runner signals. */
export async function withApp<T>(
  command: string, args: string[], options: Parameters<typeof spawnElectron>[2],
  run: (child: ChildProcess) => Promise<T>,
): Promise<T> {
  const child = spawnElectron(command, args, options);
  try { return await run(child); }
  finally { await stopElectronChild(child); }
}
