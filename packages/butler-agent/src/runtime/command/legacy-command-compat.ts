import { join } from "node:path";
import type { CommandExecutor, CommandRequest } from "./contracts.ts";

export interface LegacyCommandCompatibilityInput {
  command: string;
  cwd: string;
  environment: Readonly<Record<string, string | undefined>>;
  timeoutMs: number;
  signal?: AbortSignal;
  pipefail?: boolean;
}

export interface LegacyCommandCompatibilityResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}

/**
 * Temporary boundary for model-authored command text that predates CommandPlan.
 * Platform and shell selection stay in the child host; callers still use the
 * single structured CommandExecutor port and cannot select an adapter.
 */
export function legacyCommandCompatibilityRequest(
  input: LegacyCommandCompatibilityInput,
): CommandRequest {
  return {
    plan: {
      steps: [{
        executable: process.execPath,
        arguments: [
          "run",
          join(import.meta.dir, "legacy-command-host.ts"),
          ...(input.pipefail ? ["--pipefail"] : []),
        ],
      }],
    },
    cwd: input.cwd,
    environment: {
      ...input.environment,
      BUTLER_LEGACY_COMMAND_BASE64: Buffer.from(input.command, "utf8").toString("base64"),
    },
    inheritEnvironment: false,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  };
}

export async function executeLegacyCommandCompatibility(
  executor: CommandExecutor,
  input: LegacyCommandCompatibilityInput,
): Promise<LegacyCommandCompatibilityResult> {
  const result = await executor.execute(legacyCommandCompatibilityRequest(input));
  const errorText = result.error?.message ?? "";
  return {
    stdout: result.stdout,
    stderr: [result.stderr, errorText].filter(Boolean).join(result.stderr ? "\n" : ""),
    exit_code: result.exitCode,
    timed_out: result.timedOut,
  };
}
