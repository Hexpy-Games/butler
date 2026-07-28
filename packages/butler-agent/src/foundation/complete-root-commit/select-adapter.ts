import type { CompleteRootCommitAdapter } from "./contracts.ts";
import { darwinCompleteRootCommit } from "./adapters/darwin.ts";
import { linuxCompleteRootCommit } from "./adapters/linux.ts";
import { windowsCompleteRootCommit } from "./adapters/windows.ts";

export function selectCompleteRootCommitAdapter(
  platform: NodeJS.Platform,
): CompleteRootCommitAdapter {
  if (platform === "darwin") return darwinCompleteRootCommit;
  if (platform === "linux") return linuxCompleteRootCommit;
  if (platform === "win32") return windowsCompleteRootCommit;
  throw new Error(`Complete-root commit is unavailable on ${platform}`);
}
