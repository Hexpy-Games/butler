import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { DatabaseFileSample } from "./packaged-performance-snapshot.ts";

export function databaseFileSamples(butlerData: string): DatabaseFileSample[] {
  return listDatabaseFiles(butlerData)
    .flatMap((path) => {
      try {
        return [{
          relativePath: relative(butlerData, path).replaceAll("\\", "/"),
          sizeBytes: statSync(path).size,
        }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function listDatabaseFiles(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return listDatabaseFiles(path);
      if (!entry.isFile() || !isDatabaseFile(entry.name)) return [];
      return [path];
    });
  } catch {
    return [];
  }
}

function isDatabaseFile(name: string): boolean {
  return /\.(?:sqlite3?|db)(?:-(?:wal|shm))?$/u.test(name);
}
