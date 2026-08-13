import { createHash } from "node:crypto";

const CURSOR_VERSION = 1;

export type FileToolCursor = {
  v: typeof CURSOR_VERSION;
  tool: "list_files" | "read_file" | "grep_files";
  query: string;
  marker?: string;
  /** Last candidate path fully inspected before a traversal cap. */
  scan_path?: string;
  /** Whether scan_path should be revisited for a within-file continuation. */
  scan_inclusive?: boolean;
  /** Lexical bounds of the discovered window while applying search priority. */
  window_start_path?: string;
  window_end_path?: string;
  line?: number;
  request_index?: number;
  offset_bytes?: number;
  file_path?: string;
  file_sha256?: string;
};

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/u).some((segment) => segment === "..");
}

function compareCursorPaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Cursor ordering markers are workspace-relative metadata, not path guards.
 * Keep harmless filenames such as `version..txt`, but reject absolute, drive,
 * UNC, home-relative, and parent traversal forms before they reach traversal. */
export function isSafeRelativeCursorPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  return !(
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    value.startsWith("~") ||
    hasParentSegment(value)
  );
}

function hasTraversalFields(record: Record<string, unknown>): boolean {
  return record.scan_path !== undefined || record.scan_inclusive !== undefined;
}

function hasWindowFields(record: Record<string, unknown>): boolean {
  return record.window_start_path !== undefined || record.window_end_path !== undefined;
}

function hasReadFields(record: Record<string, unknown>): boolean {
  return record.request_index !== undefined || record.offset_bytes !== undefined || record.file_path !== undefined || record.file_sha256 !== undefined;
}

function isListCursorShape(record: Record<string, unknown>): boolean {
  return typeof record.marker === "string" && !hasTraversalFields(record) && !hasWindowFields(record) && record.line === undefined && !hasReadFields(record);
}

function isReadCursorShape(record: Record<string, unknown>): boolean {
  return record.marker === undefined && !hasTraversalFields(record) && !hasWindowFields(record) && record.line === undefined &&
    typeof record.request_index === "number" && typeof record.offset_bytes === "number" && typeof record.file_sha256 === "string";
}

function isGrepTraversalCursorShape(record: Record<string, unknown>): boolean {
  return record.scan_inclusive === false && typeof record.scan_path === "string" &&
    record.marker === undefined && record.line === undefined && !hasWindowFields(record) && !hasReadFields(record);
}

function isGrepWindowCursorShape(record: Record<string, unknown>): boolean {
  if (record.scan_inclusive !== true || typeof record.scan_path !== "string" || typeof record.marker !== "string" || typeof record.line !== "number") return false;
  if (typeof record.window_start_path !== "string" || typeof record.window_end_path !== "string" || hasReadFields(record)) return false;
  if (record.scan_path !== record.window_start_path) return false;
  if (compareCursorPaths(record.window_start_path, record.window_end_path) > 0) return false;
  return compareCursorPaths(record.marker, record.window_start_path) >= 0 && compareCursorPaths(record.marker, record.window_end_path) <= 0;
}

/** Stable, key-sorted JSON for public option fingerprints. */
export function stableCursorJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableCursorJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableCursorJson(record[key])}`).join(",")}}`;
}

export function cursorQueryHash(value: unknown): string {
  return createHash("sha256").update(stableCursorJson(value)).digest("hex");
}

export function encodeFileToolCursor(cursor: Omit<FileToolCursor, "v">): string {
  const payload: FileToolCursor = { v: CURSOR_VERSION, ...cursor };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Models sometimes serialize an omitted optional continuation as an empty
 * string. Treat only blank strings as absent; malformed non-empty values still
 * flow through decodeFileToolCursor and remain rejected.
 */
export function normalizeOptionalFileToolCursor(value: unknown): unknown {
  return typeof value === "string" && value.trim().length === 0 ? undefined : value;
}

export function decodeFileToolCursor(value: unknown): FileToolCursor | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== CURSOR_VERSION) return null;
    if (record.tool !== "list_files" && record.tool !== "read_file" && record.tool !== "grep_files") return null;
    if (typeof record.query !== "string" || !/^[a-f0-9]{64}$/u.test(record.query)) return null;
    if (record.marker !== undefined && !isSafeRelativeCursorPath(record.marker)) return null;
    if (record.scan_path !== undefined && !isSafeRelativeCursorPath(record.scan_path)) return null;
    if (record.scan_inclusive !== undefined && typeof record.scan_inclusive !== "boolean") return null;
    if (record.window_start_path !== undefined && !isSafeRelativeCursorPath(record.window_start_path)) return null;
    if (record.window_end_path !== undefined && !isSafeRelativeCursorPath(record.window_end_path)) return null;
    if (record.line !== undefined && (!Number.isInteger(record.line) || Number(record.line) < 1)) return null;
    if (record.request_index !== undefined && (!Number.isInteger(record.request_index) || Number(record.request_index) < 0)) return null;
    if (record.offset_bytes !== undefined && (!Number.isInteger(record.offset_bytes) || Number(record.offset_bytes) < 0)) return null;
    if (record.file_path !== undefined && !isSafeRelativeCursorPath(record.file_path)) return null;
    if (record.file_sha256 !== undefined && (typeof record.file_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.file_sha256))) return null;
    if (record.tool === "list_files") {
      if (!isListCursorShape(record)) return null;
    } else if (record.tool === "read_file") {
      if (!isReadCursorShape(record)) return null;
    } else {
      if (!isGrepTraversalCursorShape(record) && !isGrepWindowCursorShape(record)) return null;
    }
    return record as unknown as FileToolCursor;
  } catch {
    return null;
  }
}
