import { execFileSync, spawnSync } from "node:child_process";
import {
  ARCHIVE_STREAM_GUARD_ATTEMPTS,
  type BunRuntimeCheck,
} from "./bun-runtime-ab.ts";
import { portableGuardIdentity } from "../e2e/btcc-r3-electron/packaged-memory-campaign-evidence.ts";

export interface ElectronParentArchiveGuardInput {
  /** Electron executable (or an equivalent parent launcher) to invoke. */
  parentExecutable: string;
  parentArgs: string[];
  bunExecutable: string;
  attempts?: number;
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ElectronParentArchiveGuardResult {
  schema: "butler.archive-stream-guard.v1";
  ok: boolean;
  attempts: number;
  successes: number;
  failures: string[];
  command: string[];
  bunExecutable: string;
  bunVersion: string;
}

/**
 * Run the archived Electron-parent worker contract without shell interpolation.
 * The parent fixture must emit a final JSON object with
 * `{schema:"butler.archive-stream-guard.v1",ok:true,hasLauncher:true}`.
 */
export function runElectronParentArchiveGuard(
  input: ElectronParentArchiveGuardInput,
): ElectronParentArchiveGuardResult {
  const attempts = input.attempts ?? ARCHIVE_STREAM_GUARD_ATTEMPTS;
  const failures: string[] = [];
  const bunVersion = readBunVersion(input.bunExecutable, failures);
  let successes = 0;
  for (let index = 0; index < attempts; index += 1) {
    const result = spawnSync(input.parentExecutable, input.parentArgs, {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...input.env,
        BUTLER_BUN: input.bunExecutable,
        BUTLER_ARCHIVE_GUARD_ATTEMPT: String(index + 1),
      },
      encoding: "utf8",
      timeout: input.timeoutMs ?? 60_000,
      maxBuffer: 1024 * 1024,
    });
    const output = typeof result.stdout === "string" ? result.stdout : "";
    const marker = output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse()
      .map((line) => parseJson(line))
      .find((value) => value !== null);
    const successful = bunVersion !== "unknown" && result.status === 0 &&
      marker?.schema === "butler.archive-stream-guard.v1" &&
      marker.ok === true && marker.hasLauncher === true;
    if (successful) {
      successes += 1;
      continue;
    }
    if (result.error?.name === "Error" && /timed out|ETIMEDOUT/u.test(result.error.message)) {
      failures.push(`attempt ${index + 1}: timed out`);
    } else if (result.signal) {
      failures.push(`attempt ${index + 1}: terminated by ${result.signal}`);
    } else if (result.status !== 0) {
      failures.push(`attempt ${index + 1}: exited ${result.status ?? "unknown"}`);
    } else {
      failures.push(`attempt ${index + 1}: missing successful archive marker`);
    }
  }
  return {
    schema: "butler.archive-stream-guard.v1",
    ok: attempts >= ARCHIVE_STREAM_GUARD_ATTEMPTS && successes === attempts,
    attempts,
    successes,
    failures,
    command: [input.parentExecutable, ...input.parentArgs],
    bunExecutable: input.bunExecutable,
    bunVersion,
  };
}

function readBunVersion(executable: string, failures: string[]): string {
  try {
    const version = execFileSync(executable, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).trim();
    if (version) return version;
    failures.push("Bun executable returned an empty --version result");
  } catch (error) {
    failures.push(`Bun executable --version failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return "unknown";
}

export function archiveGuardCheck(result: ElectronParentArchiveGuardResult): BunRuntimeCheck {
  const identity = portableGuardIdentity({
    bunExecutable: result.bunExecutable,
    command: result.command,
  });
  return {
    ok: result.ok,
    schema: result.schema,
    ...(result.ok ? {} : { detail: "archive guard failed" }),
    ...(identity.commandLabel ? { commandLabel: identity.commandLabel } : {}),
    ...(identity.commandFingerprint ? { commandFingerprint: identity.commandFingerprint } : {}),
    attempts: result.attempts,
    successes: result.successes,
    ...(identity.executableLabel ? { executable: identity.executableLabel } : {}),
    ...(identity.executableFingerprint
      ? { executableFingerprint: identity.executableFingerprint }
      : {}),
    version: result.bunVersion,
  };
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
