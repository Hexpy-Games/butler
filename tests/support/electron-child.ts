import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromiumLaunchArgs } from "../../packages/butler-app/client/electron/butler-platform/chromium-features.mjs";

const children = new Set<ChildProcess>();
function killOwnedChildren(): void {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}
process.once("exit", killOwnedChildren);
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.once(signal, () => { killOwnedChildren(); process.exit(code); });
}

/** Register immediately after spawn, including the deliberately piped EPIPE smoke. */
export function trackElectronChild(child: ChildProcess): ChildProcess {
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.once("error", () => { if (!child.pid) children.delete(child); });
  return child;
}

/** File-backed diagnostics survive harness exit without a dangling pipe reader. */
export function spawnElectron(
  command: string, args: string[], options: SpawnOptions & { onOutput?: (bytes: Buffer) => void },
): ChildProcess {
  const { onOutput: output = () => {}, ...spawnOptions } = options;
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
    const child = trackElectronChild(spawn(command, chromiumLaunchArgs(args), { ...spawnOptions, stdio: ["ignore", writer, writer] }));
    child.once("exit", drain);
    child.once("close", cleanup);
    return child;
  } catch (error) { cleanup(); throw error; }
  finally { closeSync(writer); }
}

/** Always await exit before removing the profile or returning from finally. */
export async function stopElectronChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => { clearTimeout(timer); done(); });
    child.kill("SIGTERM");
  });
}
