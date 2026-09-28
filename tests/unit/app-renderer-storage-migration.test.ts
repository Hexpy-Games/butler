import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  READ_RENDERER_STORAGE_SCRIPT,
  RENDERER_STORAGE_MIGRATION_MARKER,
  migrateRendererStorageOrigin,
  normalizeRendererStorageEntries,
  writeRendererStorageScript,
} from "../../packages/butler-app/client/electron/app-renderer-storage-migration.mjs";

const roots: string[] = [];

function markerPath() {
  const root = mkdtempSync(join(tmpdir(), "butler-renderer-storage-"));
  roots.push(root);
  return join(root, "profile", RENDERER_STORAGE_MIGRATION_MARKER);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class MemoryStorage {
  private readonly values = new Map<string, string>();
  constructor(entries: Array<[string, string]> = []) {
    for (const [key, value] of entries) this.values.set(key, value);
  }
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  entries() { return Object.fromEntries(this.values); }
}

function runInPage(script: string, storage: MemoryStorage): unknown {
  return new Function("localStorage", `return ${script};`)(storage);
}

test("read script returns only Butler keys from the legacy origin", () => {
  const legacy = new MemoryStorage([
    ["butler:first-run-setup:v1", "{\"status\":\"complete\"}"],
    ["butler:settings:v1", "{}"],
    ["unrelated", "x"],
  ]);
  const raw = runInPage(READ_RENDERER_STORAGE_SCRIPT, legacy);
  expect(normalizeRendererStorageEntries(raw)).toEqual([
    ["butler:first-run-setup:v1", "{\"status\":\"complete\"}"],
    ["butler:settings:v1", "{}"],
  ]);
});

test("write script copies missing keys and never overwrites newer app-origin values", () => {
  const next = new MemoryStorage([["butler:settings:v1", "{\"new\":true}"]]);
  const copied = runInPage(writeRendererStorageScript([
    ["butler:first-run-setup:v1", "{\"status\":\"complete\"}"],
    ["butler:settings:v1", "{\"old\":true}"],
    ["butler:message-cache:v1:chat- </script>", "line sep"],
  ]), next);
  expect(copied).toBe(2);
  expect(next.entries()).toEqual({
    "butler:settings:v1": "{\"new\":true}",
    "butler:first-run-setup:v1": "{\"status\":\"complete\"}",
    "butler:message-cache:v1:chat- </script>": "line sep",
  });
});

test("entry normalization drops malformed and non-Butler entries", () => {
  expect(normalizeRendererStorageEntries(null)).toEqual([]);
  expect(normalizeRendererStorageEntries("not json")).toEqual([]);
  expect(normalizeRendererStorageEntries(JSON.stringify({ a: 1 }))).toEqual([]);
  expect(normalizeRendererStorageEntries(JSON.stringify([
    ["butler:ok", "1"],
    ["other", "2"],
    ["butler:number", 3],
    ["butler:short"],
    "butler:string",
  ]))).toEqual([["butler:ok", "1"]]);
});

test("migration copies legacy file:// storage once and records a marker", async () => {
  const path = markerPath();
  const writes: Array<Array<[string, string]>> = [];
  let reads = 0;
  const run = () => migrateRendererStorageOrigin({
    markerPath: path,
    readLegacyEntries: async () => {
      reads += 1;
      return JSON.stringify([["butler:first-run-setup:v1", "{}"], ["other", "x"]]);
    },
    writeEntries: async (entries) => {
      writes.push(entries);
      return entries.length;
    },
    now: () => new Date("2026-09-28T00:00:00.000Z"),
  });

  expect(await run()).toEqual({ status: "migrated", legacyEntries: 1, copied: 1 });
  expect(writes).toEqual([[["butler:first-run-setup:v1", "{}"]]]);
  const marker = JSON.parse(readFileSync(path, "utf8"));
  expect(marker).toEqual({
    schema: "butler.renderer-storage-origin-migration.v1",
    from: "file://",
    to: "app://butler",
    legacy_entries: 1,
    copied: 1,
    completed_at: "2026-09-28T00:00:00.000Z",
  });

  expect(await run()).toEqual({ status: "already_migrated" });
  expect(reads).toBe(1);
  expect(writes).toHaveLength(1);
});

test("empty legacy storage completes without opening the app origin", async () => {
  const path = markerPath();
  let wrote = false;
  const result = await migrateRendererStorageOrigin({
    markerPath: path,
    readLegacyEntries: async () => "[]",
    writeEntries: async () => { wrote = true; return 0; },
  });
  expect(result).toEqual({ status: "migrated", legacyEntries: 0, copied: 0 });
  expect(wrote).toBe(false);
  expect(existsSync(path)).toBe(true);
});

test("read, write and timeout failures leave no marker so the next launch retries", async () => {
  const cases = [
    { readLegacyEntries: async () => { throw Object.assign(new Error("boom"), { code: "ERR_FAILED" }); } },
    {
      readLegacyEntries: async () => JSON.stringify([["butler:a", "1"]]),
      writeEntries: async () => { throw new Error("write failed"); },
    },
    { readLegacyEntries: () => new Promise<unknown>(() => {}), timeoutMs: 10 },
  ];
  const codes: string[] = [];
  for (const options of cases) {
    const path = markerPath();
    const result = await migrateRendererStorageOrigin({
      markerPath: path,
      writeEntries: async (entries: Array<[string, string]>) => entries.length,
      ...options,
    });
    expect(result.status).toBe("failed");
    codes.push((result as { code: string }).code);
    expect(existsSync(path)).toBe(false);
  }
  expect(codes).toEqual(["err_failed", "migration_failed", "timeout"]);
});
