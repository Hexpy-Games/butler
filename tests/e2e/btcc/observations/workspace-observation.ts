import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export type FileSnapshot = Map<string, string>;

export function snapshotFiles(root: string): FileSnapshot {
  const result = new Map<string, string>();
  for (const path of walkFiles(root)) {
    result.set(
      relative(root, path).split("\\").join("/"),
      hash(readFileSync(path)),
    );
  }
  return result;
}

export function changedFiles(
  before: FileSnapshot,
  after: FileSnapshot,
): Array<{
  path: string;
  change: "created" | "modified" | "deleted";
  sha256?: string;
}> {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: Array<{
    path: string;
    change: "created" | "modified" | "deleted";
    sha256?: string;
  }> = [];
  for (const path of paths) {
    const prior = before.get(path);
    const current = after.get(path);
    if (prior === current) continue;
    if (!prior && current) {
      changes.push({ path, change: "created", sha256: current });
    } else if (prior && !current) {
      changes.push({ path, change: "deleted" });
    } else if (current) {
      changes.push({ path, change: "modified", sha256: current });
    }
  }
  return changes;
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) files.push(...walkFiles(path));
    else if (stat.isFile()) files.push(path);
  }
  return files;
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
