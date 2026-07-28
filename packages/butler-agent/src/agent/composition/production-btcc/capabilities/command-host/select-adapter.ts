import type { CommandHostAdapter } from "./contracts.ts";
import { darwinCommandHost } from "./adapters/darwin.ts";
import { posixCommandHost } from "./adapters/posix.ts";
import { windowsCommandHost } from "./adapters/windows.ts";

export function selectCommandHostAdapter(
  platform: NodeJS.Platform,
): CommandHostAdapter {
  if (platform === "darwin") return darwinCommandHost;
  if (platform === "win32") return windowsCommandHost;
  return posixCommandHost;
}
