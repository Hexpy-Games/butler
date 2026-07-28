import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { selectDurableSyncAdapter } from "./select-adapter.ts";

const adapter = selectDurableSyncAdapter(process.platform);

export function syncFile(path: string): void {
  adapter.syncFile(path);
}

export function syncDirectory(path: string): void {
  adapter.syncDirectory(path);
}

export function syncTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) syncTree(join(path, name));
    syncDirectory(path);
    return;
  }
  syncFile(path);
}

export type { DurableSyncAdapter } from "./contracts.ts";
