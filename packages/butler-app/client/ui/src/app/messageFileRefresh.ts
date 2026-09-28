import { api } from "./api.ts";
import { rememberSignedFileUrls } from "./messageFileUrls.ts";
import { isServerBackedSessionId } from "./sessionIds.ts";

type LoadJson = (path: string) => Promise<unknown>;

export interface SessionFileRefreshTarget {
  /** Cursor of the message that owns the failed file; omit for the latest page. */
  cursor?: number;
}

interface Walk {
  target?: number;
  promise: Promise<void>;
}

/** Page-size 200 windows: five pages reach far past the App's message cache. */
const MAX_PAGES = 5;
const walks = new Map<string, Walk>();

/**
 * Re-reads a session's message pages so their files get fresh signed URLs.
 * The latest page comes first; a file from an older page pages back (with the
 * fresh `previous_cursor_token` each page returns) until the page holding its
 * message. Cursor tokens expire before signed URLs, so the original page's
 * parameters cannot be replayed. Concurrent callers share one walk, which
 * goes as deep as the oldest caller needs; failures are swallowed.
 */
export function refreshSessionFileUrls(
  sessionId: string,
  target: SessionFileRefreshTarget = {},
  load: LoadJson = (path) => api(path),
): Promise<void> {
  if (!sessionId.trim() || !isServerBackedSessionId(sessionId)) {
    return Promise.resolve();
  }
  const running = walks.get(sessionId);
  if (running) {
    running.target = olderCursor(running.target, target.cursor);
    return running.promise;
  }
  const walk: Walk = { target: target.cursor, promise: Promise.resolve() };
  walk.promise = pageBack(sessionId, walk, load)
    .catch(() => undefined)
    .finally(() => walks.delete(sessionId));
  walks.set(sessionId, walk);
  return walk.promise;
}

async function pageBack(sessionId: string, walk: Walk, load: LoadJson): Promise<void> {
  const query = new URLSearchParams({ session_id: sessionId });
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const view = await load(`/session-view?${query.toString()}`);
    rememberSignedFileUrls(view);
    const window = previousPage(view);
    if (walk.target === undefined || !window) return;
    if (window.firstCursor <= walk.target) return;
    query.set("before_cursor_token", window.token);
  }
}

function previousPage(view: unknown): { firstCursor: number; token: string } | null {
  const window = (view as { message_window?: Record<string, unknown> } | null)
    ?.message_window;
  const firstCursor = window?.previous_cursor;
  const token = window?.previous_cursor_token;
  return typeof firstCursor === "number" && typeof token === "string" && token
    ? { firstCursor, token }
    : null;
}

function olderCursor(current: number | undefined, next: number | undefined) {
  if (current === undefined) return next;
  return next === undefined ? current : Math.min(current, next);
}
