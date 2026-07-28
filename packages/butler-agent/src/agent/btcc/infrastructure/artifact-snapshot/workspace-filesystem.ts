import { existsSync, rmSync } from "node:fs";
import { syncTree } from "../filesystem/durable-sync.ts";

export function syncCompleteTarget(targetPath: string): void {
  syncTree(targetPath);
}

export function removeOwnedRoot(root: string): void {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}
