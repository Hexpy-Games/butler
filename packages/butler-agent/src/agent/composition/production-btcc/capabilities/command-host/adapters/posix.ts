import type { CommandHostAdapter, CommandInvocation } from "../contracts.ts";
import { assertUnisolatedCommandAccess } from "../unisolated-access.ts";

export const posixCommandHost: CommandHostAdapter = {
  detached: true,
  invocation(command, context) {
    assertUnisolatedCommandAccess(context);
    return posixShellInvocation(command);
  },
  terminate(child) {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  },
};

export function posixShellInvocation(command: string): CommandInvocation {
  return { executable: "/bin/sh", args: ["-lc", command] };
}
