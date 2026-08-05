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

export function foregroundReadinessPath(run: PreparedRun): string {
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
  providerEndpoint: string,
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
      BUTLER_CODEX_BASE_URL: providerEndpoint,
      BUTLER_DATA: run.dataRoot,
      BUTLER_HOME: run.repoRoot,
      ...(run.providerFixtureEnabled
        ? {
          OPENAI_BASE_URL: providerEndpoint.replace(/\/responses$/u, ""),
          ...(run.modelApiRetryAttempts !== undefined
            ? { BUTLER_MODEL_API_RETRY_ATTEMPTS: String(run.modelApiRetryAttempts) }
            : {}),
        }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));
  assert(child.pid, "Native Butler executor did not expose a PID.");
  try {
    await waitForNativeExecutorReadiness(run, {
      expectedPid: child.pid,
      owner: child,
    });
    writeJson(nativeExecutorStatePath(run), {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      runtime: "codex-api",
      launcher: "btcc-r3-electron-e2e",
    });
    return { child, output };
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

export async function waitForNativeExecutorReadiness(
  run: PreparedRun,
  input: {
    expectedPid?: number;
    notBeforeMs?: number;
    owner?: ChildProcess;
    timeoutMs?: number;
  } = {},
): Promise<number> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? 120_000;
  while (Date.now() - startedAt < timeoutMs) {
    if (
      input.owner &&
      (input.owner.exitCode !== null || input.owner.signalCode !== null)
    ) {
      throw new Error(
        `Native Butler owner exited before executor readiness: ${
          input.owner.exitCode ?? input.owner.signalCode
        }`,
      );
    }
    try {
      const readiness = parseJsonFile(foregroundReadinessPath(run));
      const pid = isRecord(readiness) && Number.isInteger(readiness.pid)
        ? Number(readiness.pid)
        : null;
      const readyAtMs = isRecord(readiness) && typeof readiness.readyAt === "string"
        ? Date.parse(readiness.readyAt)
        : Number.NaN;
      if (
        isRecord(readiness) &&
        readiness.schema === "butler.app-foreground-executor-readiness.v1" &&
        pid !== null &&
        pid > 0 &&
        (input.expectedPid === undefined || pid === input.expectedPid) &&
        (input.notBeforeMs === undefined ||
          (Number.isFinite(readyAtMs) && readyAtMs >= input.notBeforeMs)) &&
        isPidRunning(pid)
      ) {
        return pid;
      }
    } catch {
      // Readiness is published atomically by the production runtime.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error("Timed out waiting for the native Butler executor.");
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
