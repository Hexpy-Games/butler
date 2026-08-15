import { Buffer } from "node:buffer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DEFAULT_SESSION_MESSAGE_PAGE_SIZE = 200;
export const MAX_SESSION_MESSAGE_PAGE_SIZE = 200;
/** Cursor tokens are intentionally short-lived so a stale window resyncs. */
export const SESSION_CURSOR_TTL_MS = 5 * 60 * 1000;
const SESSION_CURSOR_VERSION = 1;
const SESSION_CURSOR_SECRET = randomBytes(32);

export interface SessionMessagePageOptions {
  /** Return rows after this stable session-local rowid cursor. */
  afterCursor?: number;
  afterCursorToken?: string;
  /** Return the previous page before this stable session-local rowid cursor. */
  beforeCursor?: number;
  beforeCursorToken?: string;
  /** Walk the canonical history from the oldest row for bounded exports. */
  fromBeginning?: boolean;
  limit?: number;
}

export interface SessionMessagePage<T> {
  items: T[];
  nextCursor: number;
  previousCursor: number | null;
  hasMore: boolean;
}

export interface TranscriptMessage {
  cursor: number;
  role: string;
  text: string;
}

export interface TranscriptMessagePage {
  items: TranscriptMessage[];
  nextCursor: number;
  hasMore: boolean;
}

export function normalizeSessionMessagePageOptions(
  options: SessionMessagePageOptions = {},
): Required<Pick<SessionMessagePageOptions, "limit">> &
  Omit<SessionMessagePageOptions, "limit"> {
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(MAX_SESSION_MESSAGE_PAGE_SIZE, Math.floor(options.limit!)))
    : DEFAULT_SESSION_MESSAGE_PAGE_SIZE;
  const normalizedAfter = normalizeCursor(options.afterCursor);
  const normalizedBefore = normalizeCursor(options.beforeCursor);
  const afterCursor = normalizedAfter && normalizedAfter > 0
    ? normalizedAfter
    : undefined;
  const beforeCursor = normalizedBefore && normalizedBefore > 0
    ? normalizedBefore
    : undefined;
  // A page cannot be both a forward delta and an older-history page. Prefer
  // the explicit older cursor so callers cannot accidentally duplicate rows.
  return {
    limit,
    ...(options.fromBeginning ? { fromBeginning: true } : {}),
    ...(beforeCursor !== undefined
      ? {
          beforeCursor,
          ...(typeof options.beforeCursorToken === "string"
            ? { beforeCursorToken: options.beforeCursorToken }
            : {}),
        }
      : {}),
    ...(beforeCursor === undefined && afterCursor !== undefined
      ? {
          afterCursor,
          ...(typeof options.afterCursorToken === "string"
            ? { afterCursorToken: options.afterCursorToken }
            : {}),
        }
      : {}),
  };
}

export function normalizeCursor(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const cursor = Number(value);
  return Number.isFinite(cursor) && cursor >= 0 ? Math.floor(cursor) : undefined;
}

export function encodeSessionCursor(
  sessionId: string,
  cursor: number,
  now = Date.now(),
): string {
  const payload = Buffer.from(JSON.stringify({
      v: SESSION_CURSOR_VERSION,
      s: sessionId,
      c: Math.max(0, Math.floor(cursor)),
      e: now + SESSION_CURSOR_TTL_MS,
    }), "utf8").toString("base64url");
  const signature = createHmac("sha256", SESSION_CURSOR_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function decodeSessionCursor(
  token: string,
  sessionId: string,
  now = Date.now(),
): number | undefined {
  try {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return undefined;
    const expectedSignature = createHmac("sha256", SESSION_CURSOR_SECRET)
      .update(payload)
      .digest("base64url");
    const providedBytes = Buffer.from(signature, "base64url");
    const expectedBytes = Buffer.from(expectedSignature, "base64url");
    if (providedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(providedBytes, expectedBytes)) return undefined;
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      v?: unknown;
      s?: unknown;
      c?: unknown;
      e?: unknown;
    };
    const cursor = normalizeCursor(value.c);
    const expiresAt = normalizeCursor(value.e);
    return value.v === SESSION_CURSOR_VERSION && value.s === sessionId &&
      expiresAt !== undefined && expiresAt > now
      ? cursor
      : undefined;
  } catch {
    return undefined;
  }
}
