import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromiumLaunchArgs } from "../../packages/butler-app/client/electron/butler-platform/chromium-features.mjs";

import { killOwnedProcessGroup, ownedProcessGroupAlive } from "../../packages/butler-app/client/electron/butler-platform/process-group.mjs";

type OwnedElectron = { child: ChildProcess; paths: string[]; stop?: Promise<void>; commandLine?: string };
const children = new Map<ChildProcess, OwnedElectron>();
// Group leaders the harness did not spawn but discovered as its own: a relaunched App and the Agent
// it launched. Electron's relauncher starts the App detached, as a new group leader under launchd.
const adopted = new Set<number>();
/** Kills the adopted groups now; one that already exited is skipped. */
export function killAdoptedProcessGroups(): void {
  for (const pid of adopted) { try { killOwnedProcessGroup(pid); } catch { /* already exited */ } }
  adopted.clear();
}
/**
 * Adopts the groups the spawned Apps led to: each relaunched App of a `relaunches` child (a group
 * leader under launchd running exactly the command line this harness spawned; a relaunch repeats its
 * argv) and every new group led by a child of an owned or adopted process (an App's Agent).
 * Returns the PIDs adopted now.
 */
export function discoverOwnedGroups(): number[] {
  if (process.platform === "win32" || !children.size) return [];
  const lines = new Set([...children.values()].flatMap((entry) => entry.commandLine ? [entry.commandLine] : []));
  const rows = (spawnSync("ps", ["-axo", "pid=,pgid=,ppid=,command="], { encoding: "utf8" }).stdout ?? "").split("\n").flatMap((line) => {
    const [, pid, pgid, ppid, command] = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/u.exec(line) ?? [];
    return pid ? [{ pid: Number(pid), pgid: Number(pgid), ppid: Number(ppid), command: command! }] : [];
  });
  const owned = new Set([...adopted, ...[...children.values()].flatMap((entry) => entry.child.pid ? [entry.child.pid] : [])]);
  const members = () => new Set(rows.filter((row) => owned.has(row.pgid)).map((row) => row.pid));
  const found: number[] = [];
  for (let grown = true; grown;) {
    grown = false;
    const parents = members();
    for (const row of rows) {
      if (row.pid !== row.pgid || owned.has(row.pid)) continue;
      if ((row.ppid === 1 && lines.has(row.command)) || parents.has(row.ppid)) { owned.add(row.pid); adopted.add(row.pid); found.push(row.pid); grown = true; }
    }
  }
  return found;
}
function killOwnedChildren(): void {
  // Discover while the parents are alive (an orphaned Agent is no longer anyone's child), then kill;
  // discover again for a successor the relauncher started before its group died.
  discoverOwnedGroups();
  const groups = [...adopted, ...[...children.values()].flatMap((entry) => entry.child.pid ? [entry.child.pid] : [])];
  for (const pid of groups) { try { killOwnedProcessGroup(pid); } catch { /* already exited */ } }
  discoverOwnedGroups();
  groups.push(...adopted);
  killAdoptedProcessGroups();
  // Exit hooks are synchronous: wait (bounded) until the killed groups are gone, so no member still
  // writes into a profile or data folder that this or a later exit hook removes.
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (const deadline = Date.now() + 5000; Date.now() < deadline && groups.some((pid) => ownedProcessGroupAlive(pid));) Atomics.wait(pause, 0, 0, 20);
  adopted.clear();
  for (const entry of children.values()) for (const path of entry.paths) rmSync(path, { recursive: true, force: true });
  children.clear();
}
process.once("exit", killOwnedChildren);
process.on("uncaughtExceptionMonitor", killOwnedChildren);
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.once(signal, () => { killOwnedChildren(); process.exit(code); });
}

/**
 * The caller must spawn detached; even the deliberately piped EPIPE smoke.
 * `relaunches`: the App may relaunch itself. Electron's relauncher stays in this group and starts the
 * successor after the leader exits, so the group outlives its leader until stopElectronChild. The
 * successor leads a new group; discoverOwnedGroups adopts it, and every exit path kills it.
 */
export function trackElectronChild(child: ChildProcess, paths: string[] = [], relaunches = false): ChildProcess {
  const entry: OwnedElectron = { child, paths, commandLine: relaunches ? child.spawnargs.join(" ") : undefined };
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
    if (entry.commandLine) discoverOwnedGroups();
    if (child.pid) {
      killOwnedProcessGroup(child.pid);
      const deadline = Date.now() + 5000;
      while (ownedProcessGroupAlive(child.pid)) {
        if (Date.now() >= deadline) throw new Error(`Owned Electron group ${child.pid} did not exit`);
        await new Promise(done => setTimeout(done, 20));
      }
    }
    if (entry.commandLine) { discoverOwnedGroups(); killAdoptedProcessGroups(); }
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
