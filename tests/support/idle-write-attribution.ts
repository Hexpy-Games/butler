import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { cpSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Database } from "bun:sqlite";

type FileState = { path: string; kind: string; size: number; mtime_ms: number; inode: number; sha256: string; pages?: string[]; walPages?: { page: number; commit_pages: number; sha256: string }[] };
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Chromium blockfile OnDiskStats: signature, size, 28 size buckets, 22 counters.
// Report numeric statistics only, never shader blobs or local-storage values.
function chromiumStats(bytes: Buffer): unknown {
  const offset = bytes.indexOf(Buffer.from([0xe0, 0x27, 0x14, 0xf0]));
  if (offset < 0 || offset + 296 > bytes.length || bytes.readUInt32LE(offset + 4) !== 296) return undefined;
  const names = ["open_miss", "open_hit", "create_miss", "create_hit", "resurrect_hit", "create_error",
    "trim_entry", "doom_entry", "doom_cache", "invalid_entry", "open_entries", "max_entries", "timer",
    "read_data", "write_data", "open_rankings", "get_rankings", "fatal_error", "last_report", "last_report_timer", "doom_recent_entries", "unused"];
  return { offset, size: 296, counters: Object.fromEntries(names.map((name, index) =>
    [name, bytes.readBigInt64LE(offset + 120 + index * 8).toString()])) };
}

function byteChanges(before: Buffer, after: Buffer): unknown {
  const ranges: { offset: number; length: number }[] = [];
  for (let offset = 0; offset < Math.max(before.length, after.length); offset++) {
    if (before[offset] === after[offset]) continue;
    const previous = ranges.at(-1);
    if (previous && previous.offset + previous.length === offset) previous.length++;
    else ranges.push({ offset, length: 1 });
  }
  return { changed_bytes: ranges.reduce((sum, range) => sum + range.length, 0), ranges };
}

/** Diagnostic fixture only: never open a live SQLite database or retain secrets. */
export class IdleWriteAttribution {
  private previous = new Map<string, FileState>();
  private tables = new Map<string, unknown>();
  private changes: { index: number; path: string }[] = [];
  private contents = new Map<string, Buffer>();
  private contentChanges: unknown[] = [];

  constructor(private roots: Record<string, string>, private copies: string, private evidence: string) {
    mkdirSync(copies, { recursive: true });
  }

  sample(index: number, processIo: unknown, loadAverage1m: number): void {
    this.contentChanges = [];
    const files = Object.entries(this.roots).flatMap(([label, root]) => this.scan(root, label, root));
    const current = new Map(files.map(file => [file.path, file]));
    const changed = files.filter(file => JSON.stringify(file) !== JSON.stringify(this.previous.get(file.path)));
    const removed = [...this.previous.keys()].filter(path => !current.has(path));
    if (index > 0) this.changes.push(...[...changed.map(file => file.path), ...removed].map(path => ({ index, path })));
    const databasePaths = new Set(changed.filter(file => file.pages).map(file => file.path.replace(/-wal$/u, "")));
    const databases = [...databasePaths].flatMap(path => current.has(path) ? [this.database(current.get(path)!)] : []);
    const pageChanges = changed.filter(file => file.pages).map(file => ({ path: file.path,
      pages: file.pages!.flatMap((checksum, page) => checksum === this.previous.get(file.path)?.pages?.[page] ? [] : [page + 1]),
      walFrames: file.walPages?.flatMap((frame, index) => JSON.stringify(frame) === JSON.stringify(this.previous.get(file.path)?.walPages?.[index]) ? [] : [{ frame: index + 1, ...frame }]) }));
    writeFileSync(join(this.evidence, `idle-${String(index).padStart(2, "0")}.json`), JSON.stringify({
      index, at: new Date().toISOString(), loadAverage1m, processIo, files,
      changed: changed.map(({ pages: _pages, walPages: _walPages, ...file }) => file), pageChanges, databases,
      removed, contentChanges: this.contentChanges,
    }, null, 2));
    this.previous = current;
  }

  assertUnchanged(): void {
    assert.deepEqual(this.changes, [], "zero idle changes across DATA, Electron profile and helper/home profiles");
  }

  private scan(root: string, label: string, dir: string): FileState[] {
    try {
      return readdirSync(dir).sort().flatMap(name => {
        const path = join(dir, name), stat = lstatSync(path);
        if (stat.isDirectory()) return this.scan(root, label, path);
        const kind = stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "special";
        const bytes = stat.isFile() ? readFileSync(path) : stat.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : Buffer.alloc(0);
        const key = `${label}/${relative(root, path)}`;
        const previousBytes = this.contents.get(key);
        if (previousBytes && !previousBytes.equals(bytes)) this.contentChanges.push({ path: key,
          ...byteChanges(previousBytes, bytes) as object,
          ...(key.endsWith("/data_1") ? { chromium_stats: { before: chromiumStats(previousBytes), after: chromiumStats(bytes) } } : {}) });
        this.contents.set(key, bytes);
        const sqlite = stat.isFile() && bytes.length >= 100 && bytes.subarray(0, 16).toString() === "SQLite format 3\0";
        const wal = stat.isFile() && path.endsWith("-wal") && bytes.length >= 32;
        const rawSize = sqlite ? bytes.readUInt16BE(16) : wal ? bytes.readUInt32BE(8) : 0;
        const pageSize = rawSize === 1 ? 65536 : rawSize;
        const pages = pageSize ? Array.from({ length: Math.ceil(bytes.length / pageSize) }, (_, page) =>
          hash(bytes.subarray(page * pageSize, (page + 1) * pageSize))) : undefined;
        if (sqlite || wal || (stat.isFile() && path.endsWith("-journal"))) {
          const copy = join(this.copies, key); mkdirSync(join(copy, ".."), { recursive: true }); cpSync(path, copy);
        }
        const walPages = wal ? Array.from({ length: Math.floor((bytes.length - 32) / (pageSize + 24)) }, (_, index) => {
          const offset = 32 + index * (pageSize + 24);
          return { page: bytes.readUInt32BE(offset), commit_pages: bytes.readUInt32BE(offset + 4),
            sha256: hash(bytes.subarray(offset + 24, offset + 24 + pageSize)) };
        }) : undefined;
        return [{ path: key, kind, size: stat.size, mtime_ms: stat.mtimeMs, inode: stat.ino, sha256: hash(bytes), ...(pages ? { pages } : {}), ...(walPages ? { walPages } : {}) }];
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private database(file: FileState): unknown {
    // A changed WAL can affect tables even when the main DB pages are unchanged.
    const path = join(this.copies, file.path);
    rmSync(`${path}-shm`, { force: true });
    const db = new Database(path);
    try {
      const names = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
      const tables = names.map(({ name }) => {
        let rows: Record<string, unknown>[];
        try { rows = db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() as Record<string, unknown>[]; }
        catch (error) { return { name, unavailable: (error as Error).message }; }
        const columns = Object.fromEntries(Object.keys(rows[0] ?? {}).map(column => [column,
          hash(rows.map(row => hash(JSON.stringify(row[column]))).sort().join("\n"))]));
        const fingerprint = { name, rows: rows.length, sha256: hash(rows.map(row => hash(JSON.stringify(row))).sort().join("\n")), columns };
        const key = `${file.path}/${name}`, previous = this.tables.get(key);
        this.tables.set(key, fingerprint);
        const previousColumns = (previous as { columns?: Record<string, string> } | undefined)?.columns;
        return { ...fingerprint, changed: JSON.stringify(previous) !== JSON.stringify(fingerprint),
          changed_columns: Object.keys(columns).filter(column => columns[column] !== previousColumns?.[column]) };
      });
      let pageOwners: unknown;
      try { pageOwners = db.query("SELECT name,pageno,pagetype FROM dbstat ORDER BY pageno").all(); }
      catch { pageOwners = "dbstat unavailable in fixture SQLite"; }
      return { path: file.path, tables, pageOwners };
    } finally { db.close(); }
  }
}
