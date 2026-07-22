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
  if (!boundary || boundary.deniedReadWriteRoots.length === 0) {
    return shellInvocation(command);
  }
  if (process.platform !== "darwin") {
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

function shellInvocation(command: string): CommandInvocation {
  return { executable: "/bin/sh", args: ["-lc", command] };
}

function macosSandboxProfile(roots: string[]): string {
  const rules = [...new Set(roots.map(canonicalRoot))]
    .map((root) => [
      `(deny file-read-data (subpath "${sandboxLiteral(root)}"))`,
      `(deny file-write* (subpath "${sandboxLiteral(root)}"))`,
    ].join("\n"));
  return ["(version 1)", "(allow default)", ...rules].join("\n");
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
