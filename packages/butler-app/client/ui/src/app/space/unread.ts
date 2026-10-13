import { useDocumentAttended } from "../documentAttention.ts";
import { useButlerStore } from "../store.ts";
import type { SessionSummary } from "../types";
import { spaceActivity } from "./activity";
import type { SpaceRowData } from "./projection";

/**
 * True when the session has a finished reply the user has not seen. A chat
 * that is open in this attended window counts as seen: it is being read.
 */
export function useSessionUnread(session?: SessionSummary): boolean {
  const attended = useDocumentAttended();
  const onScreen = useButlerStore(
    (state) => state.view.kind === "session" && state.activeChatId === session?.id,
  );
  return Boolean(session?.unread) && !(attended && onScreen);
}

/** A reply is due to be marked read: it is unread and its turn has ended. */
export function readDue(session?: SessionSummary | null): boolean {
  return Boolean(session?.unread) && spaceActivity(session ?? undefined) !== "working";
}

const ancestorIndexes = new WeakMap<Map<string, SpaceRowData>, ReadonlySet<string>>();

/** Keys of the groups and projects that hold an unread session at any depth. */
export function unreadAncestors(rows: Map<string, SpaceRowData>): ReadonlySet<string> {
  const cached = ancestorIndexes.get(rows);
  if (cached) return cached;
  const keys = new Set<string>();
  for (const row of rows.values()) {
    if (row.session?.unread) for (const key of row.ancestors) keys.add(key);
  }
  ancestorIndexes.set(rows, keys);
  return keys;
}
