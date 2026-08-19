import { lstat, readFile } from "node:fs/promises";
import { resolveWorkspacePathGuard, safeWorkspaceResultPath } from "../shared/workspace-path-guard.ts";
import { sha256Hex } from "../shared/evidence.ts";
import { isSafeRelativeCursorPath } from "../shared/cursor.ts";
import type { FileToolExecutionContext } from "./executor.ts";

export const DEFAULT_MAX_BYTES = 65_536;
export const MAX_FILE_BYTES = 1_048_576;

export type ReadRequest = {
  path: string;
  start_line?: number;
  limit_lines?: number;
  max_bytes: number;
};

export type ReadFileResult = Record<string, unknown> & { ok: boolean };

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

function decodeUtf8(data: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

export function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(Math.floor(parsed), max));
}

export function normalizeRequest(value: unknown): ReadRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || !record.path.trim()) return null;
  return {
    path: record.path.trim(),
    ...(record.start_line === undefined ? {} : { start_line: integer(record.start_line, 1, 1, 10_000_000) }),
    ...(record.limit_lines === undefined ? {} : { limit_lines: integer(record.limit_lines, 1, 1, 10_000) }),
    max_bytes: integer(record.max_bytes, DEFAULT_MAX_BYTES, 1, MAX_FILE_BYTES),
  };
}

export function normalizedQueryRequests(requests: readonly ReadRequest[], maxTotalBytes: number): unknown {
  return {
    requests: requests.map((request) => ({
      path: request.path,
      ...(request.start_line === undefined ? {} : { start_line: request.start_line }),
      ...(request.limit_lines === undefined ? {} : { limit_lines: request.limit_lines }),
      max_bytes: request.max_bytes,
    })),
    max_total_bytes: maxTotalBytes,
  };
}

function charIndexAtByteOffset(text: string, offset: number): number {
  if (offset <= 0) return 0;
  let used = 0;
  let index = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > offset) break;
    used += size;
    index += ch.length;
    if (used === offset) break;
  }
  return index;
}

function isUtf8ByteBoundary(text: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0) return false;
  let used = 0;
  if (offset === 0) return true;
  for (const ch of text) {
    used += Buffer.byteLength(ch, "utf8");
    if (used === offset) return true;
    if (used > offset) return false;
  }
  return used === offset;
}

function charIndexAtLine(text: string, line: number): number {
  if (line <= 1) return 0;
  let currentLine = 1;
  let index = 0;
  for (const ch of text) {
    index += ch.length;
    if (ch === "\n") {
      currentLine += 1;
      if (currentLine >= line) return index;
    }
  }
  return text.length;
}

export function utf8Slice(text: string, maxBytes: number): { content: string; bytes: number } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { content: text, bytes: Buffer.byteLength(text, "utf8") };
  let used = 0;
  let index = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > maxBytes) break;
    used += size;
    index += ch.length;
  }
  return { content: text.slice(0, index), bytes: used };
}

function lineNumberAtChar(text: string, charIndex: number): number {
  if (charIndex <= 0) return 1;
  return text.slice(0, charIndex).split("\n").length;
}

function lineWindow(text: string, startChar: number, limitLines?: number): { candidate: string; endChar: number; limited: boolean } {
  if (limitLines === undefined) return { candidate: text.slice(startChar), endChar: text.length, limited: false };
  let seenLines = 0;
  for (let index = startChar; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    seenLines += 1;
    if (seenLines >= limitLines) {
      return { candidate: text.slice(startChar, index), endChar: index, limited: index < text.length };
    }
  }
  return { candidate: text.slice(startChar), endChar: text.length, limited: false };
}

function readFailure(path: string, error: string, message: string, recoveryHint: string): ReadFileResult {
  return { ok: false, path, error, message, recovery_hint: recoveryHint };
}

export async function readOneFile(
  request: ReadRequest,
  workspaceRoot: string,
  context: FileToolExecutionContext,
  continuationOffset?: number,
): Promise<{
  result: ReadFileResult;
  sha256?: string;
  outputBytes: number;
  /** Number of bytes obtained from the filesystem before UTF-8/response clipping. */
  bytesRead: number;
  hasMore: boolean;
  cursorInvalid?: boolean;
  startOffset?: number;
  nextOffset?: number;
}> {
  const guard = await resolveWorkspacePathGuard({
    workspaceRoot,
    relativePath: request.path,
    relativeOnly: context.allowedToolsAndEffects !== undefined,
    rejectProtectedProjectLedgerPaths: true,
    protectedProjectLedgerRoots: context.protectedProjectLedgerRoots,
  });
  if (!guard.ok) {
    const error = guard.reason === "directory_not_allowed" ? "not_a_file" : guard.reason ?? "path_rejected";
    const safePath = context.allowedToolsAndEffects === undefined
      ? request.path
      : safeWorkspaceResultPath({
          workspaceRoot: guard.workspaceRoot,
          requestedPath: request.path,
          absolutePath: guard.absolutePath,
        }) ?? ".";
    return {
      result: readFailure(safePath, error, "The file path is not an admitted workspace file.", "Choose a contained, non-sensitive regular file path."),
      outputBytes: 0,
      bytesRead: 0,
      hasMore: false,
    };
  }
  const filePath = guard.realPath ?? guard.absolutePath!;
  let fileStat;
  try {
    fileStat = await lstat(filePath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT") {
      return { result: readFailure(request.path, "io_error", "The workspace file could not be inspected.", "Check workspace permissions and retry the read."), outputBytes: 0, bytesRead: 0, hasMore: false };
    }
    return { result: readFailure(request.path, "not_found", "The requested workspace file was not found.", "Restart discovery or choose an existing file."), outputBytes: 0, bytesRead: 0, hasMore: false };
  }
  if (!fileStat.isFile()) {
    return { result: readFailure(request.path, "not_a_file", "The requested path is not a regular file.", "Choose a regular file path returned by list_files."), outputBytes: 0, bytesRead: 0, hasMore: false };
  }
  // Recheck immediately before the read. Traversal and reads must never
  // follow a candidate that was swapped to a symlink after guard admission.
  try {
    const currentStat = await lstat(filePath);
    if (!currentStat.isFile()) {
      return { result: readFailure(request.path, "not_a_file", "The requested path is no longer a regular file.", "Restart discovery and choose a regular file path returned by list_files."), outputBytes: 0, bytesRead: 0, hasMore: false };
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    return { result: readFailure(request.path, code === "ENOENT" ? "not_found" : "io_error", code === "ENOENT" ? "The requested workspace file was not found." : "The workspace file could not be inspected before reading.", "Check workspace permissions and retry the read."), outputBytes: 0, bytesRead: 0, hasMore: false };
  }
  let data: Buffer;
  try {
    data = await readFile(filePath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    return { result: readFailure(request.path, code === "ENOENT" ? "not_found" : "io_error", code === "ENOENT" ? "The requested workspace file was not found." : "The workspace file could not be read.", "Check workspace permissions and retry the read."), outputBytes: 0, bytesRead: 0, hasMore: false };
  }
  const sha256 = sha256Hex(data);
  if (isBinary(data)) {
    return { result: readFailure(request.path, "binary_file_not_supported", "Binary workspace files are not supported by read_file.", "Choose a UTF-8 text file."), sha256, outputBytes: 0, bytesRead: data.byteLength, hasMore: false };
  }
  const decoded = decodeUtf8(data);
  if (decoded === null) {
    return { result: readFailure(request.path, "invalid_utf8", "The workspace file is not valid UTF-8 text.", "Choose a UTF-8 text file or convert it before reading."), sha256, outputBytes: 0, bytesRead: data.byteLength, hasMore: false };
  }
  const text = decoded.replace(/\r\n?/g, "\n");
  if (continuationOffset !== undefined) {
    const normalizedBytes = Buffer.byteLength(text, "utf8");
    if (continuationOffset > normalizedBytes || !isUtf8ByteBoundary(text, continuationOffset)) {
      return {
        result: readFailure(request.path, "invalid_cursor", "The read_file cursor offset is outside the current UTF-8 byte boundaries.", "Restart read_file without cursor and continue from a newly issued cursor."),
        sha256,
        outputBytes: 0,
        bytesRead: data.byteLength,
        hasMore: false,
        cursorInvalid: true,
      };
    }
  }
  const startChar = continuationOffset === undefined
    ? request.start_line === undefined ? 0 : charIndexAtLine(text, request.start_line)
    : charIndexAtByteOffset(text, continuationOffset);
  const startLine = lineNumberAtChar(text, startChar);
  const window = lineWindow(text, startChar, request.limit_lines);
  const selected = utf8Slice(window.candidate, request.max_bytes);
  const baseBytes = Buffer.byteLength(text.slice(0, startChar), "utf8");
  const candidateBytes = Buffer.byteLength(window.candidate, "utf8");
  if (candidateBytes > 0 && selected.bytes === 0) {
    return {
      result: readFailure(request.path, "max_bytes_too_small_for_utf8", "The per-file byte budget cannot include the next UTF-8 character without splitting it.", "Increase max_bytes to at least the next UTF-8 character size."),
      sha256,
      outputBytes: 0,
      bytesRead: data.byteLength,
      hasMore: false,
      startOffset: baseBytes,
    };
  }
  let nextOffset = baseBytes + selected.bytes;
  const selectedFullWindow = selected.bytes >= candidateBytes;
  // A line-limited page intentionally omits its trailing delimiter. Advance
  // over that delimiter so a continuation starts at the next line rather
  // than yielding a stranded newline or restarting the same line.
  if (selectedFullWindow && window.limited && text.charAt(window.endChar) === "\n") nextOffset += 1;
  const remainingBytes = Buffer.byteLength(text.slice(charIndexAtByteOffset(text, nextOffset)), "utf8");
  const hasMore = remainingBytes > 0;
  const contentLines = selected.content.length ? selected.content.split("\n") : [];
  const endLine = contentLines.length ? startLine + contentLines.length - 1 : startLine - 1;
  const result: ReadFileResult = {
    ok: true,
    path: request.path,
    bytes: data.length,
    sha256,
    truncated: hasMore,
    byte_truncated: selected.bytes < candidateBytes,
    start_line: startLine,
    end_line: endLine,
    content: selected.content,
  };
  return { result, sha256, outputBytes: selected.bytes, bytesRead: data.byteLength, hasMore, startOffset: baseBytes, ...(hasMore ? { nextOffset } : {}) };
}

export function cursorSafePath(path: string): string | undefined {
  return isSafeRelativeCursorPath(path) ? path : undefined;
}
