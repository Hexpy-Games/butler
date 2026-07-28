import type { DurableSyncAdapter } from "./contracts.ts";
import { posixDurableSync } from "./adapters/posix.ts";
import { windowsDurableSync } from "./adapters/windows.ts";

export function selectDurableSyncAdapter(
  platform: NodeJS.Platform,
): DurableSyncAdapter {
  return platform === "win32" ? windowsDurableSync : posixDurableSync;
}
