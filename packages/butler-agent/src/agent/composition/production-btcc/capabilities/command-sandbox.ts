import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { CapabilityExecutionContext } from "./contracts.ts";
import { OperationRejectedError } from "../../../btcc/index.ts";

export type CommandInvocation = {
  executable: string;
  args: string[];
};

export function isolatedCommandInvocation(
  command: string,
  context: CapabilityExecutionContext,
): CommandInvocation {
  const boundary = context.commandFilesystemBoundary;
  if (!boundary) {
    return shellInvocation(command);
  }
  if (boundary.kind === "read_only_observation") {
    return readOnlyObservationInvocation(command, context.accessMode);
  }
  if (boundary.deniedReadWriteRoots.length === 0) return shellInvocation(command);
  if (process.platform !== "darwin") {
    if (context.accessMode === "full_access") return shellInvocation(command);
    throw new OperationRejectedError(
      "command_filesystem_isolation_unavailable",
      "This host cannot establish the required isolated command filesystem boundary.",
    );
  }
  return {
    executable: "/usr/bin/sandbox-exec",
    args: ["-p", macosSandboxProfile(boundary.deniedReadWriteRoots), "/bin/sh", "-lc", command],
  };
}

function readOnlyObservationInvocation(
  command: string,
  accessMode: CapabilityExecutionContext["accessMode"],
): CommandInvocation {
  if (process.platform === "darwin") {
    return {
      executable: "/usr/bin/sandbox-exec",
      args: ["-p", macosReadOnlyObservationProfile(), "/bin/sh", "-lc", command],
    };
  }
  if (accessMode === "full_access") return shellInvocation(command);
  throw new OperationRejectedError(
    "command_observation_isolation_unavailable",
    "This host cannot enforce the admitted read-only local command boundary.",
  );
}

function shellInvocation(command: string): CommandInvocation {
  if (process.platform === "win32") return windowsShellInvocation(command);
  return { executable: "/bin/sh", args: ["-lc", command] };
}

export function windowsShellInvocation(
  command: string,
  comspec = process.env.ComSpec,
): CommandInvocation {
  return {
    executable: comspec?.trim() || "cmd.exe",
    args: ["/d", "/s", "/c", command],
  };
}

function macosSandboxProfile(roots: string[]): string {
  const rules = [...new Set(roots.map(canonicalRoot))]
    .map((root) => [
      `(deny file-read-data (subpath "${sandboxLiteral(root)}"))`,
      `(deny file-write* (subpath "${sandboxLiteral(root)}"))`,
    ].join("\n"));
  return ["(version 1)", "(allow default)", ...rules].join("\n");
}

function macosReadOnlyObservationProfile(): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(deny network*)",
  ].join("\n");
}

function canonicalRoot(root: string): string {
  try {
    return realpathSync.native(root);
  } catch {
    return resolve(root);
  }
}

function sandboxLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
