import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { resolveWorkspacePathGuard } from
  "../../../tools/file-tools/shared/workspace-path-guard.ts";
import { butlerToolProcessEnvironment } from
  "../../../tool-support/executor-support.ts";
import { selectCommandHostAdapter } from "./command-host.ts";
import { GuidedCommandRejectedError } from "./command-error.ts";
import { CommandOutputSpool } from "./command-output-spool.ts";
import type {
  CommandOutputSummary,
  GuidedCommandContext,
  SpooledCommandOutput,
} from "./contracts.ts";

const commandHost = selectCommandHostAdapter(process.platform);

export async function executeGuidedCommand(
  args: Record<string, unknown>,
  context: GuidedCommandContext,
): Promise<SpooledCommandOutput> {
  const command = requireString(args.command, "command");
  const cwd = await resolveGuidedCommandDirectory(context.workspacePath, args.cwd);
  const timeoutMs = number(args.timeout_ms, 120_000);
  const invocation = commandHost.invocation(command, context);
  const environment = butlerToolProcessEnvironment({ butlerData: context.butlerData });
  if (context.filesystemBoundary.kind === "isolated_validation") {
    environment.HOME = context.filesystemBoundary.homeRoot;
    environment.TMPDIR = context.filesystemBoundary.tempRoot;
    environment.TMP = context.filesystemBoundary.tempRoot;
    environment.TEMP = context.filesystemBoundary.tempRoot;
    environment.BUTLER_ARTIFACTS_DIR = context.filesystemBoundary.artifactRoot;
    environment.BUTLER_ARTIFACT_DIR = context.filesystemBoundary.artifactRoot;
  }
  return new Promise((resolve, reject) => {
    const spool = new CommandOutputSpool(context.butlerData);
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      detached: commandHost.detached,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    });
    let timedOut = false;
    spool.capture(child.stdout, child.stderr);
    const terminate = () => commandHost.terminate(child);
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const abort = () => terminate();
    context.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
      spool.discard();
      reject(error);
    });
    child.once("close", async (exitCode, signal) => {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
      commandHost.terminateDescendants(child);
      if (context.signal?.aborted) {
        spool.discard();
        reject(context.signal.reason ?? new Error("Command cancelled"));
        return;
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
