import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

export function syncFile(path: string): void {
  const descriptor = openSync(path, process.platform === "win32" ? "r+" : "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
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
