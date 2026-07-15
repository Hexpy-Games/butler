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
 * Platform and shell selection stay inside this infrastructure boundary;
 * callers still use the single structured CommandExecutor port and cannot
 * select an adapter. The command travels over stdin so the platform executor
 * owns one child process tree without a nested runtime host.
 */
export function legacyCommandCompatibilityRequest(
  input: LegacyCommandCompatibilityInput,
  platform: NodeJS.Platform = process.platform,
): CommandRequest {
  const shell = platform === "win32"
    ? {
        executable: "powershell.exe",
        arguments: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "-",
        ],
      }
    : {
        executable: "/bin/bash",
        arguments: input.pipefail ? ["-o", "pipefail", "-s"] : ["-s"],
      };
  return {
    plan: {
      steps: [shell],
    },
    cwd: input.cwd,
    environment: input.environment,
    inheritEnvironment: false,
    stdin: input.command,
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
