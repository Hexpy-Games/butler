import { spawn } from "node:child_process";
import type { CapabilityExecutionContext } from "./contracts.ts";
import { resolveWorkspacePathGuard } from "../../../tools/file-tools/shared/workspace-path-guard.ts";
import { OperationRejectedError } from "../../../btcc/core/index.ts";
import { commandHost } from "./command-host/index.ts";
import {
  CommandOutputSpool,
  type CommandOutputSummary,
} from "./command-output-spool.ts";

export async function executeCommandCapability(
  args: Record<string, unknown>,
  context: CapabilityExecutionContext,
): Promise<unknown> {
  const command = requireString(args.command, "command");
  const cwd = await resolveCommandDirectory(context.workspacePath, args.cwd);
  const timeoutMs = number(args.timeout_ms, 120_000);
  const invocation = commandHost.invocation(command, context);
  return new Promise((resolve, reject) => {
    const spool = new CommandOutputSpool(context.butlerData);
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      detached: commandHost.detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    spool.capture(child.stdout, child.stderr);
    const terminate = () => {
      commandHost.terminate(child);
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    const abort = () => terminate();
    context.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      spool.discard();
      reject(error);
    });
    child.once("close", async (exitCode, signal) => {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
      if (context.signal?.aborted) {
        spool.discard();
        return reject(context.signal.reason ?? new Error("Command cancelled"));
      }
      const summary: CommandOutputSummary = {
        command,
        cwd,
        exitCode,
        signal,
        timedOut,
      };
      try {
        resolve(await spool.complete(summary));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function resolveCommandDirectory(workspaceRoot: string, value: unknown): Promise<string> {
  if (value === undefined || value === "") return workspaceRoot;
  const guarded = await resolveWorkspacePathGuard({
    workspaceRoot,
    relativePath: requireString(value, "cwd"),
    allowDirectories: true,
  });
  if (!guarded.ok || !guarded.absolutePath) {
    throw new OperationRejectedError(
      guarded.reason ?? "command_cwd_rejected",
      "The requested command directory is outside the admitted workspace safety policy.",
    );
  }
  return guarded.absolutePath;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a string`);
  return value;
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
