import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandHostAdapter, CommandInvocation } from "../contracts.ts";

export const darwinCommandHost: CommandHostAdapter = {
  detached: true,
  invocation(command, context) {
    const boundary = context.commandFilesystemBoundary;
    if (!boundary) return shellInvocation(command);
    if (boundary.kind === "read_only_observation") {
      return sandboxInvocation(command, readOnlyProfile());
    }
    if (boundary.deniedReadWriteRoots.length === 0) return shellInvocation(command);
    return sandboxInvocation(command, isolatedProfile(boundary.deniedReadWriteRoots));
  },
  terminate(child) {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  },
};

function shellInvocation(command: string): CommandInvocation {
  return { executable: "/bin/sh", args: ["-lc", command] };
}

function sandboxInvocation(command: string, profile: string): CommandInvocation {
  return {
    executable: "/usr/bin/sandbox-exec",
    args: ["-p", profile, "/bin/sh", "-lc", command],
  };
}

function isolatedProfile(roots: string[]): string {
  const rules = [...new Set(roots.map(canonicalRoot))]
    .map((root) => [
      `(deny file-read-data (subpath "${sandboxLiteral(root)}"))`,
      `(deny file-write* (subpath "${sandboxLiteral(root)}"))`,
    ].join("\n"));
  return ["(version 1)", "(allow default)", ...rules].join("\n");
}

function readOnlyProfile(): string {
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
