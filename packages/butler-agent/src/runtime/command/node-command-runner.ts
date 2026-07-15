import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
  CommandInvocation,
  CommandRequest,
  CommandResult,
} from "./contracts.ts";
import {
  directProcessContainment,
  type CommandProcessContainment,
} from "./process-containment.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

export async function runNodeCommand(
  invocations: readonly CommandInvocation[],
  request: CommandRequest,
  containment: CommandProcessContainment = directProcessContainment,
): Promise<CommandResult> {
  const startedAt = Date.now();
  if (request.signal?.aborted) {
    return result({ startedAt, cancelled: true });
  }
  if (invocations.length === 0) {
    return result({
      startedAt,
      error: {
        code: "command_plan_empty",
        message: "command plan must contain at least one executable step",
      },
    });
  }

  return await new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const children: ChildProcessWithoutNullStreams[] = [];
    const exitCodes: Array<number | null> = [];
    const stderrDecoders: StringDecoder[] = [];
    const stdoutDecoder = new StringDecoder("utf8");
    let closedChildren = 0;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (value: Partial<CommandResult> = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      request.signal?.removeEventListener("abort", onAbort);
      resolveResult(result({
        startedAt,
        stdout,
        stderr,
        timedOut,
        cancelled,
        ...value,
      }));
    };
    const terminate = () => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          containment.signal(child, "SIGTERM");
        }
      }
      if (forceTimer) return;
      forceTimer = setTimeout(() => {
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) {
            containment.signal(child, "SIGKILL");
          }
        }
      }, 500);
      forceTimer.unref?.();
    };
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    for (const invocation of invocations) {
      const child = spawn(invocation.executable, [...invocation.arguments], {
        ...(request.cwd ? { cwd: request.cwd } : {}),
        env: {
          ...process.env,
          ...request.environment,
        },
        shell: false,
        detached: containment.detached,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      children.push(child);
      exitCodes.push(null);
      stderrDecoders.push(new StringDecoder("utf8"));
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, boundedTimeout(request.timeoutMs));
    timeout.unref?.();

    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
    const lastChild = children.at(-1)!;
    lastChild.stdout.on("data", (chunk) => {
      stdout += stdoutDecoder.write(chunk);
    });
    lastChild.stdout.once("end", () => {
      stdout += stdoutDecoder.end();
    });
    children.forEach((child, index) => {
      child.stderr.on("data", (chunk) => {
        stderr += stderrDecoders[index]!.write(chunk);
      });
      child.stderr.once("end", () => {
        stderr += stderrDecoders[index]!.end();
      });
      child.once("error", (error) => {
        terminate();
        settle({
          exitCode: null,
          error: {
            code: safeErrorCode(error),
            message: "command process could not be started",
          },
        });
      });
      child.once("close", (exitCode) => {
        exitCodes[index] = exitCode;
        closedChildren += 1;
        if (closedChildren !== children.length) return;
        settle({
          exitCode: timedOut || cancelled ? null : pipelineExitCode(exitCodes),
        });
      });
    });

    for (let index = 0; index < children.length - 1; index += 1) {
      children[index]!.stdout.pipe(children[index + 1]!.stdin);
    }
    children[0]!.stdin.end(request.stdin ?? "");
  });
}

function pipelineExitCode(exitCodes: readonly (number | null)[]): number | null {
  for (let index = exitCodes.length - 1; index >= 0; index -= 1) {
    const exitCode = exitCodes[index];
    if (exitCode !== null && exitCode !== 0) return exitCode;
  }
  return exitCodes.at(-1) ?? null;
}

function boundedTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.trunc(value!)));
}

function safeErrorCode(error: unknown): string {
  const value = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "command_spawn_failed";
  return value.replace(/[^a-z0-9_.-]/giu, "_").slice(0, 80) || "command_spawn_failed";
}

function result(input: {
  startedAt: number;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  cancelled?: boolean;
  error?: CommandResult["error"];
}): CommandResult {
  return {
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
    exitCode: input.exitCode ?? null,
    timedOut: input.timedOut === true,
    cancelled: input.cancelled === true,
    durationMs: Math.max(0, Date.now() - input.startedAt),
    error: input.error ?? null,
  };
}
