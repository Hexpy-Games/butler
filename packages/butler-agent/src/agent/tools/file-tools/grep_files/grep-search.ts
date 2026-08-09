import { lstat, readFile } from "node:fs/promises";
import type { WorkspaceTraversalEntry } from "../shared/workspace-traversal.ts";

export const MAX_MATCH_TEXT_BYTES = 16_384;
export const MAX_READ_CONCURRENCY = 4;

export type SearchMatch = {
  path: string;
  line: number;
  text: string;
  context: Array<{ line: number; text: string }>;
  /** Set when aggregate max_output_bytes clipped text/context payload. */
  payload_truncated?: boolean;
};

export type CandidateReadResult = {
  skipped: boolean;
  reason?: "max_bytes_per_file" | "binary" | "invalid_utf8" | "io_error" | "symlink";
  matches: SearchMatch[];
  bytesRead: number;
  attemptedRead: boolean;
  withinFileTruncated?: boolean;
  withinFileLastLine?: number;
};

export function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function isBinary(buffer: Buffer): boolean {
  const n = Math.min(buffer.length, 4096);
  for (let i = 0; i < n; i += 1) if (buffer[i] === 0) return true;
  return false;
}

function decodeUtf8(buffer: Buffer): string | null {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { return null; }
}

function boundedText(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_MATCH_TEXT_BYTES) return value;
  let used = 0;
  let end = 0;
  for (const ch of value) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > MAX_MATCH_TEXT_BYTES) break;
    used += size;
    end += ch.length;
  }
  return value.slice(0, end);
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let used = 0;
  let end = 0;
  for (const ch of value) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > maxBytes) break;
    used += size;
    end += ch.length;
  }
  return value.slice(0, end);
}

export async function mapBounded<T, R>(values: readonly T[], concurrency: number, callback: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await callback(values[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length || 1) }, worker));
  return results;
}

function matchPayloadBytes(match: SearchMatch): number {
  return Buffer.byteLength(match.text, "utf8") + match.context.reduce((sum, line) => sum + Buffer.byteLength(line.text, "utf8"), 0);
}

export function fitMatchToBudget(match: SearchMatch, availableBytes: number): { match: SearchMatch; bytes: number; truncated: boolean } {
  let remaining = Math.max(0, availableBytes);
  const text = utf8Prefix(match.text, remaining);
  remaining -= Buffer.byteLength(text, "utf8");
  const context: Array<{ line: number; text: string }> = [];
  let truncated = text !== match.text;
  for (const line of match.context) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const clipped = utf8Prefix(line.text, remaining);
    remaining -= Buffer.byteLength(clipped, "utf8");
    context.push({ line: line.line, text: clipped });
    if (clipped !== line.text) {
      truncated = true;
      break;
    }
  }
  if (context.length < match.context.length) truncated = true;
  const fitted: SearchMatch = { path: match.path, line: match.line, text, context, ...(truncated ? { payload_truncated: true } : {}) };
  return { match: fitted, bytes: matchPayloadBytes(fitted), truncated };
}

export async function readCandidate(
  candidate: WorkspaceTraversalEntry,
  matcherSource: string,
  matcherFlags: string,
  contextLines: number,
  maxBytesPerFile: number,
  maxMatches: number,
  maxOutputBytes: number,
  after?: { path: string; line: number } | null,
): Promise<CandidateReadResult> {
  if (candidate.bytes > maxBytesPerFile) return { skipped: true, reason: "max_bytes_per_file", matches: [], bytesRead: 0, attemptedRead: false };
  try {
    const currentStat = await lstat(candidate.absolutePath);
    if (!currentStat.isFile()) return { skipped: true, reason: "symlink", matches: [], bytesRead: 0, attemptedRead: false };
    // Traversal metadata is only a discovery hint. Recheck the current size
    // immediately before read so a file that grew after traversal cannot
    // bypass the declared per-file byte budget.
    if (currentStat.size > maxBytesPerFile) return { skipped: true, reason: "max_bytes_per_file", matches: [], bytesRead: 0, attemptedRead: false };
  } catch {
    return { skipped: true, reason: "io_error", matches: [], bytesRead: 0, attemptedRead: true };
  }
  let data: Buffer;
  try {
    data = await readFile(candidate.absolutePath);
  } catch {
    return { skipped: true, reason: "io_error", matches: [], bytesRead: 0, attemptedRead: true };
  }
  if (isBinary(data)) return { skipped: true, reason: "binary", matches: [], bytesRead: data.byteLength, attemptedRead: true };
  const decoded = decodeUtf8(data);
  if (decoded === null) return { skipped: true, reason: "invalid_utf8", matches: [], bytesRead: data.byteLength, attemptedRead: true };
  let matcher: RegExp;
  try { matcher = new RegExp(matcherSource, matcherFlags); } catch { return { skipped: true, reason: "io_error", matches: [], bytesRead: data.byteLength, attemptedRead: true }; }
  const lines = decoded.replace(/\r\n?/g, "\n").split("\n");
  const matches: SearchMatch[] = [];
  const candidateMatchBudget = maxOutputBytes + MAX_MATCH_TEXT_BYTES * (contextLines + 1);
  let candidateMatchBytes = 0;
  for (let index = 0; index < lines.length; index += 1) {
    matcher.lastIndex = 0;
    if (!matcher.test(lines[index]!)) continue;
    if (after && candidate.path === after.path && index + 1 <= after.line) continue;
    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length - 1, index + contextLines);
    const match: SearchMatch = {
      path: candidate.path,
      line: index + 1,
      text: boundedText(lines[index]!),
      context: lines.slice(start, end + 1).map((text, offset) => ({ line: start + offset + 1, text: boundedText(text) })),
    };
    matches.push(match);
    candidateMatchBytes += matchPayloadBytes(match);
    if (matches.length >= maxMatches || candidateMatchBytes >= candidateMatchBudget) {
      let hasFutureMatch = false;
      for (let future = index + 1; future < lines.length; future += 1) {
        matcher.lastIndex = 0;
        if (matcher.test(lines[future]!)) {
          hasFutureMatch = true;
          break;
        }
      }
      return {
        skipped: false,
        matches,
        bytesRead: data.byteLength,
        attemptedRead: true,
        ...(hasFutureMatch ? { withinFileTruncated: true, withinFileLastLine: index + 1 } : {}),
      };
    }
  }
  return { skipped: false, matches, bytesRead: data.byteLength, attemptedRead: true };
}
