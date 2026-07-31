import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type {
  CommandHostAdapter,
  CommandInvocation,
  GuidedCommandContext,
} from "./contracts.ts";
import { GuidedCommandRejectedError } from "./command-error.ts";

export function selectCommandHostAdapter(platform: NodeJS.Platform): CommandHostAdapter {
  if (platform === "darwin") return darwinCommandHost;
  if (platform === "win32") return windowsCommandHost;
  return posixCommandHost;
}

const darwinCommandHost: CommandHostAdapter = {
  detached: true,
  invocation(command) {
    return sandboxInvocation(command, readOnlyProfile());
  },
  terminate(child) {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  },
};

const posixCommandHost: CommandHostAdapter = {
  detached: true,
  invocation(command, context) {
    assertUnisolatedCommandAccess(context);
    return shellInvocation(command);
  },
  terminate(child) {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  },
};

const windowsCommandHost: CommandHostAdapter = {
  detached: false,
  invocation(command, context) {
    assertUnisolatedCommandAccess(context);
    return windowsShellInvocation(command);
  },
  terminate(child) {
    child.kill("SIGTERM");
  },
};

function shellInvocation(command: string): CommandInvocation {
  return { executable: "/bin/sh", args: ["-lc", command] };
}

function windowsShellInvocation(command: string): CommandInvocation {
  const executable = process.env.ComSpec?.trim() || "cmd.exe";
  return { executable, args: ["/d", "/s", "/c", command] };
}

function sandboxInvocation(command: string, profile: string): CommandInvocation {
  return {
    executable: "/usr/bin/sandbox-exec",
    args: ["-p", profile, "/bin/sh", "-lc", command],
  };
}

function readOnlyProfile(): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    '(allow file-write-data (literal "/dev/null"))',
    "(deny network*)",
  ].join("\n");
}

function assertUnisolatedCommandAccess(context: GuidedCommandContext): void {
  if (context.accessMode === "full_access") return;
  throw new GuidedCommandRejectedError(
    "command_observation_isolation_unavailable",
    "This host cannot enforce the admitted read-only local command boundary.",
  );
}

export function canonicalCommandRoot(root: string): string {
  try {
    return realpathSync.native(root);
  } catch {
    return resolve(root);
  }
}
