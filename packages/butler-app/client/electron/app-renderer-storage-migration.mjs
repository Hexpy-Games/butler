import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The renderer used to run on file://, so its localStorage (first-run
// completion, UI state and caches) lives under that origin. The app://butler
// origin starts empty; copy the Butler keys over once. The legacy copy stays
// in place, so a downgrade still finds its data.
export const RENDERER_STORAGE_MIGRATION_SCHEMA = "butler.renderer-storage-origin-migration.v1";
export const RENDERER_STORAGE_MIGRATION_MARKER = "renderer-storage-origin-migration.json";
export const RENDERER_STORAGE_KEY_PREFIX = "butler:";
// Loaded with `baseURLForDataURL`, this blank document commits on the base
// URL's origin, so each origin's storage is reachable without booting the UI.
export const RENDERER_STORAGE_BLANK_PAGE_URL = `data:text/html;charset=utf-8,${
  encodeURIComponent("<!doctype html><title>Butler</title>")
}`;

export const READ_RENDERER_STORAGE_SCRIPT = `(() => {
  const entries = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (typeof key === "string" && key.startsWith(${JSON.stringify(RENDERER_STORAGE_KEY_PREFIX)})) {
      entries.push([key, localStorage.getItem(key)]);
    }
  }
  return JSON.stringify(entries);
})()`;

export function writeRendererStorageScript(entries) {
  return `(() => {
  const entries = ${JSON.stringify(entries)};
  let copied = 0;
  for (const [key, value] of entries) {
    if (localStorage.getItem(key) !== null) continue;
    localStorage.setItem(key, value);
    copied += 1;
  }
  return copied;
})()`;
}

export function normalizeRendererStorageEntries(raw) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter((entry) =>
    Array.isArray(entry) &&
    entry.length === 2 &&
    typeof entry[0] === "string" &&
    entry[0].startsWith(RENDERER_STORAGE_KEY_PREFIX) &&
    typeof entry[1] === "string");
}

export async function migrateRendererStorageOrigin({
  markerPath,
  readLegacyEntries,
  writeEntries,
  now = () => new Date(),
  timeoutMs = 15_000,
}) {
  if (existsSync(markerPath)) return { status: "already_migrated" };
  try {
    const entries = normalizeRendererStorageEntries(
      await withTimeout(readLegacyEntries(), timeoutMs),
    );
    const copied = entries.length > 0
      ? Number(await withTimeout(writeEntries(entries), timeoutMs)) || 0
      : 0;
    mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 });
    writeFileSync(markerPath, `${JSON.stringify({
      schema: RENDERER_STORAGE_MIGRATION_SCHEMA,
      from: "file://",
      to: "app://butler",
      legacy_entries: entries.length,
      copied,
      completed_at: now().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    return { status: "migrated", legacyEntries: entries.length, copied };
  } catch (error) {
    return { status: "failed", code: safeMigrationCode(error) };
  }
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error("Renderer storage migration timed out."), { code: "timeout" })),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function safeMigrationCode(error) {
  const code = typeof error?.code === "string" ? error.code.toLowerCase() : "";
  return /^[a-z0-9_]{1,64}$/u.test(code) ? code : "migration_failed";
}
