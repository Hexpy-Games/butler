import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

export function syncCompleteTarget(targetPath: string): void {
  const stat = lstatSync(targetPath);
  if (stat.isDirectory()) {
    for (const name of readdirSync(targetPath)) {
      syncCompleteTarget(join(targetPath, name));
    }
  }
  if (!stat.isSymbolicLink()) {
    const descriptor = openSync(targetPath, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}

export function removeOwnedRoot(root: string): void {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}
