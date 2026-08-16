import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { resolveWorkspacePathGuard } from
  "../../../tools/file-tools/shared/workspace-path-guard.ts";
import { butlerToolProcessEnvironment } from
  "../../../tools/tool-executor-support.ts";
import { selectCommandHostAdapter } from "./command-host.ts";
import { GuidedCommandRejectedError } from "./command-error.ts";
import { CommandOutputSpool } from "./command-output-spool.ts";
import type {
  CommandOutputSummary,
  GuidedCommandContext,
  SpooledCommandOutput,
} from "./contracts.ts";

const commandHost = selectCommandHostAdapter(process.platform);
const TERMINATION_GRACE_MS = 500;
const FORCE_SETTLEMENT_GRACE_MS = 500;

type TerminationCause =
  | { kind: "timeout" }
  | { kind: "abort"; reason: unknown };

export async function executeGuidedCommand(
  args: Record<string, unknown>,
  context: GuidedCommandContext,
): Promise<SpooledCommandOutput> {
  const command = requireString(args.command, "command");
  const cwd = await resolveGuidedCommandDirectory(context.workspacePath, args.cwd);
  const timeoutMs = number(args.timeout_ms, 120_000);
  const invocation = commandHost.invocation(command, context);
  const environment = butlerToolProcessEnvironment({ butlerData: context.butlerData });
  return new Promise((resolve, reject) => {
    const spool = new CommandOutputSpool(context.butlerData);
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      detached: commandHost.detached,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    });
    let settled = false;
    let terminationCause: TerminationCause | undefined;
    let forcedTerminationSent = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let forcedSettlementTimer: ReturnType<typeof setTimeout> | undefined;
    spool.capture(child.stdout, child.stderr);

    const clearLifecycle = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (forcedSettlementTimer) clearTimeout(forcedSettlementTimer);
      context.signal?.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearLifecycle();
      spool.discard();
      reject(error);
    };
    const signalFailure = (signal: NodeJS.Signals, error: unknown) =>
      new GuidedCommandRejectedError(
        "command_termination_failed",
        `Failed to deliver ${signal} while terminating the guided command: ${errorMessage(error)}`,
      );
    const forceTerminateOnce = (): boolean => {
      if (forcedTerminationSent) return true;
      forcedTerminationSent = true;
      try {
        commandHost.terminateDescendants(child);
        return true;
      } catch (error) {
        fail(signalFailure("SIGKILL", error));
        return false;
      }
    };
    const settle = async (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      forceOutputClose: boolean,
    ) => {
      if (settled) return;
      if (!forceTerminateOnce()) return;
      settled = true;
      clearLifecycle();
      if (forceOutputClose) spool.stopCapture();
      if (terminationCause?.kind === "abort") {
        spool.discard();
        reject(terminationCause.reason);
        return;
      }
      const summary: CommandOutputSummary = {
        command,
        cwd,
        exitCode,
        signal,
        timedOut: terminationCause?.kind === "timeout",
      };
      try {
        resolve(await spool.complete(summary));
      } catch (error) {
        reject(error);
      }
    };
    const requestTermination = (cause: TerminationCause) => {
      if (terminationCause || settled) return;
      terminationCause = cause;
      try {
        commandHost.terminate(child);
      } catch (error) {
        fail(signalFailure("SIGTERM", error));
        return;
      }
      forceTimer = setTimeout(() => {
        if (settled) return;
        if (!forceTerminateOnce()) return;
        forcedSettlementTimer = setTimeout(() => {
          void settle(null, child.signalCode, true);
        }, FORCE_SETTLEMENT_GRACE_MS);
      }, TERMINATION_GRACE_MS);
    };
    const abort = () => requestTermination({
      kind: "abort",
      reason: context.signal?.reason ?? new Error("Command cancelled"),
    });

    const timeoutTimer = setTimeout(
      () => requestTermination({ kind: "timeout" }),
      timeoutMs,
    );
    context.signal?.addEventListener("abort", abort, { once: true });
    if (context.signal?.aborted) abort();
    child.once("error", (error) => {
      if (!forceTerminateOnce()) return;
      fail(error);
    });
    child.once("close", async (exitCode, signal) => {
      await settle(
        terminationCause ? null : exitCode,
        signal,
        false,
      );
    });
  });
}

export async function resolveGuidedCommandDirectory(
  workspaceRoot: string,
  value: unknown,
): Promise<string> {
  if (value === undefined || value === "") return workspaceRoot;
  const requested = requireString(value, "cwd");
  if (isAbsolute(requested) && resolve(requested) === resolve(workspaceRoot)) {
    return workspaceRoot;
  }
  const guarded = await resolveWorkspacePathGuard({
    workspaceRoot,
    relativePath: requested,
    allowDirectories: true,
  });
  if (!guarded.ok || !guarded.absolutePath) {
    throw new GuidedCommandRejectedError(
      guarded.reason ?? "command_cwd_rejected",
      "The requested command directory is outside the admitted workspace safety policy.",
    );
  }
  return guarded.absolutePath;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
