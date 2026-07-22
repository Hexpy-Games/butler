import { spawn } from "node:child_process";
import type { CapabilityExecutionContext } from "./contracts.ts";
import { resolveWorkspacePathGuard } from "../../../tools/file-tools/shared/workspace-path-guard.ts";
import { OperationRejectedError } from "../../../btcc/index.ts";
import { isolatedCommandInvocation } from "./command-sandbox.ts";

export async function executeCommandCapability(
  args: Record<string, unknown>,
  context: CapabilityExecutionContext,
): Promise<unknown> {
  const command = requireString(args.command, "command");
  const cwd = await resolveCommandDirectory(context.workspacePath, args.cwd);
  const timeoutMs = number(args.timeout_ms, 120_000);
  const maxOutput = number(args.max_output_tokens, 20_000) * 4;
  const invocation = isolatedCommandInvocation(command, context);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer) => (current + chunk.toString("utf8")).slice(-maxOutput);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const terminate = () => {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    const abort = () => terminate();
    context.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
      if (context.signal?.aborted) return reject(context.signal.reason ?? new Error("Command cancelled"));
      resolve({ command, cwd, exitCode, signal, timedOut, stdout, stderr });
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
