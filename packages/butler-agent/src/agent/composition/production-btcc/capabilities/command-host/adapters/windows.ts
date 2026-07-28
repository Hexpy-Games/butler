import type { CommandHostAdapter, CommandInvocation } from "../contracts.ts";
import { assertUnisolatedCommandAccess } from "../unisolated-access.ts";

export const windowsCommandHost: CommandHostAdapter = {
  detached: false,
  invocation(command, context) {
    assertUnisolatedCommandAccess(context);
    return windowsShellInvocation(command);
  },
  terminate(child) {
    child.kill("SIGTERM");
  },
};

export function windowsShellInvocation(
  command: string,
  comspec = process.env.ComSpec,
): CommandInvocation {
  return {
    executable: comspec?.trim() || "cmd.exe",
    args: ["/d", "/s", "/c", command],
  };
}
