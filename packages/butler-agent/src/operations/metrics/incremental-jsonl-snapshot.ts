import { closeSync, openSync, readSync, readFileSync, statSync } from "fs";

export interface IncrementalJsonlSnapshot<T> {
  values: T[];
  parseErrors: number;
}

interface SnapshotCacheEntry<T> extends IncrementalJsonlSnapshot<T> {
  maxEntries: number;
  device: number;
  inode: number;
  byteLength: number;
  mtimeMs: number;
  pendingTail: string;
}

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_ENTRIES = 100_000;
const snapshotCache = new Map<string, SnapshotCacheEntry<unknown>>();

export function readIncrementalJsonlSnapshot<T>(
  path: string,
  parseLine: (line: string) => T | null,
  options: {
    maxEntries?: number;
    maxFiles?: number;
  } = {},
): IncrementalJsonlSnapshot<T> {
  const maxEntries = Math.max(
    1,
    Math.trunc(options.maxEntries ?? DEFAULT_MAX_ENTRIES),
  );
  const maxFiles = Math.max(
    1,
    Math.trunc(options.maxFiles ?? DEFAULT_MAX_FILES),
  );
  const snapshot = readSnapshotFile(path, parseLine, maxEntries, maxFiles);
  return {
    values: [...snapshot.values],
    parseErrors: snapshot.parseErrors,
  };
}

function readSnapshotFile<T>(
  path: string,
  parseLine: (line: string) => T | null,
  maxEntries: number,
  maxFiles: number,
): SnapshotCacheEntry<T> {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    snapshotCache.delete(path);
    return emptySnapshotCacheEntry();
  }

  const previous = snapshotCache.get(path) as SnapshotCacheEntry<T> | undefined;
  if (
    previous &&
    previous.maxEntries === maxEntries &&
    previous.device === stat.dev &&
    previous.inode === stat.ino &&
    previous.byteLength === stat.size &&
    previous.mtimeMs === stat.mtimeMs
  ) {
    touchSnapshotCache(path, previous, maxFiles);
    return previous;
  }

  if (
    previous &&
    previous.maxEntries === maxEntries &&
    previous.device === stat.dev &&
    previous.inode === stat.ino &&
    stat.size > previous.byteLength
  ) {
    const appended = readFileBytes(
      path,
      previous.byteLength,
      stat.size - previous.byteLength,
    );
    const parsed = parseJsonlText(
      `${previous.pendingTail}${appended}`,
      parseLine,
    );
    const next: SnapshotCacheEntry<T> = {
      ...previous,
      values: [...previous.values, ...parsed.values].slice(-maxEntries),
      parseErrors: previous.parseErrors + parsed.parseErrors,
      pendingTail: parsed.pendingTail,
      byteLength: stat.size,
      mtimeMs: stat.mtimeMs,
    };
    snapshotCache.set(path, next);
    touchSnapshotCache(path, next, maxFiles);
    return next;
  }

  const parsed = parseJsonlText(readFileSync(path, "utf8"), parseLine);
  const next: SnapshotCacheEntry<T> = {
    maxEntries,
    device: stat.dev,
    inode: stat.ino,
    byteLength: stat.size,
    mtimeMs: stat.mtimeMs,
    values: parsed.values.slice(-maxEntries),
    parseErrors: parsed.parseErrors,
    pendingTail: parsed.pendingTail,
  };
  snapshotCache.delete(path);
  snapshotCache.set(path, next);
  trimSnapshotCache(maxFiles);
  return next;
}

function readFileBytes(path: string, position: number, length: number): string {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(length);
    const read = readSync(fd, bytes, 0, length, position);
    return bytes.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function parseJsonlText<T>(
  raw: string,
  parseLine: (line: string) => T | null,
): {
  values: T[];
  parseErrors: number;
  pendingTail: string;
} {
  const lines = raw.split("\n");
  const values: T[] = [];
  let parseErrors = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value = parseLine(line);
      if (value === null) {
        parseErrors += 1;
      } else {
        values.push(value);
      }
    } catch {
      parseErrors += 1;
    }
  }
  return { values, parseErrors, pendingTail: "" };
}

function emptySnapshotCacheEntry<T>(): SnapshotCacheEntry<T> {
  return {
    maxEntries: 0,
    device: 0,
    inode: 0,
    byteLength: 0,
    mtimeMs: 0,
    values: [],
    parseErrors: 0,
    pendingTail: "",
  };
}

function touchSnapshotCache<T>(
  path: string,
  entry: SnapshotCacheEntry<T>,
  maxFiles: number,
): void {
  snapshotCache.delete(path);
  snapshotCache.set(path, entry);
  trimSnapshotCache(maxFiles);
}

function trimSnapshotCache(maxFiles: number): void {
  while (snapshotCache.size > maxFiles) {
    const first = snapshotCache.keys().next().value as string | undefined;
    if (first === undefined) break;
    snapshotCache.delete(first);
  }
}
