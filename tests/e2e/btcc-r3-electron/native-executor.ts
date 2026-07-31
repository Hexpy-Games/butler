import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { PreparedRun } from "./contracts.ts";
import {
  assert,
  isRecord,
  parseJsonFile,
} from "./scenario-preflight.ts";

function nativeExecutorStatePath(run: PreparedRun): string {
  return join(run.dataRoot, "state", "butler-main-native.json");
}

function foregroundReadinessPath(run: PreparedRun): string {
  return join(run.dataRoot, "state", "app-foreground", "executor-ready.json");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function startNativeExecutor(
  run: PreparedRun,
  output: string[] = [],
): Promise<{
  child: ChildProcess;
  output: string[];
}> {
  const script = join(
    run.repoRoot,
    "packages",
    "butler-agent",
    "scripts",
    "native-butler-main.ts",
  );
  assert(existsSync(script), `Native Butler executor entrypoint is missing: ${script}`);
  const child = spawn(process.execPath, ["run", script], {
    cwd: run.repoRoot,
    env: {
      ...process.env,
      BUTLER_BUN: process.execPath,
      BUTLER_DATA: run.dataRoot,
      BUTLER_HOME: run.repoRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));
  assert(child.pid, "Native Butler executor did not expose a PID.");
  const startedAt = Date.now();
  while (Date.now() - startedAt < 120_000) {
    if (child.exitCode !== null) {
      throw new Error(`Native Butler executor exited before readiness: ${child.exitCode}`);
    }
    try {
      const readiness = parseJsonFile(foregroundReadinessPath(run));
      if (
        isRecord(readiness) &&
        readiness.schema === "butler.app-foreground-executor-readiness.v1" &&
        readiness.pid === child.pid
      ) {
        writeJson(nativeExecutorStatePath(run), {
          pid: child.pid,
          startedAt: new Date().toISOString(),
          runtime: "codex-api",
          launcher: "btcc-r3-electron-e2e",
        });
        return { child, output };
      }
    } catch {
      // Readiness is published atomically by the production runtime.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  child.kill("SIGTERM");
  throw new Error("Timed out waiting for the native Butler executor.");
}

export function hasInterruptedInboundForExecutor(
  run: PreparedRun,
  pid: number | undefined,
): boolean {
  if (!pid) return false;
  const pending = join(run.dataRoot, "runtime", "inbound-events", "pending");
  if (!existsSync(pending)) return false;
  for (const name of readdirSync(pending)) {
    if (!name.endsWith(".json")) continue;
    try {
      const value = parseJsonFile(join(pending, name));
      if (!isRecord(value) || !isRecord(value.metadata)) continue;
      if (
        value.metadata.sameLogicalTurnContinuation === true &&
        value.metadata.resumeAfterProcessId === pid
      ) return true;
    } catch {
      // The queue record may be atomically moved while it is inspected.
    }
  }
  return false;
}

export async function stopChildProcess(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill(signal);
  const exited = await Promise.race([
    new Promise<boolean>((resolveExit) =>
      child.once("exit", () => resolveExit(true)),
    ),
    new Promise<boolean>((resolveWait) =>
      setTimeout(() => resolveWait(false), 12_000),
    ),
  ]);
  if (!exited && child.exitCode === null) child.kill("SIGKILL");
}

export async function stopNativeExecutor(
  run: PreparedRun,
  child: ChildProcess,
): Promise<void> {
  await stopChildProcess(child);
  if (!child.pid) return;
  for (const path of [nativeExecutorStatePath(run), foregroundReadinessPath(run)]) {
    try {
      const value = parseJsonFile(path);
      if (isRecord(value) && value.pid === child.pid) rmSync(path, { force: true });
    } catch {
      // Missing or already-cleared fixture state needs no repair.
    }
  }
}
