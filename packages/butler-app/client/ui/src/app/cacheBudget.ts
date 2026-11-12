import sharedCacheBudget from "../../../shared/cache-budget.json";

/**
 * Shared renderer/preload cache contract.
 *
 * Durable conversation history remains in the App Gateway. The desktop cache
 * is only a bounded rehydration window: it may evict completed sessions, but
 * must never become a second history store or evict active compose state.
 */
export const APP_CACHE_BUDGET = Object.freeze({
  /** Maximum number of completed session snapshots retained in memory/storage. */
  maxEntries: sharedCacheBudget.maxEntries,
  /** Aggregate serialized bytes across message snapshots. */
  maxBytes: sharedCacheBudget.maxBytes,
  /** A single snapshot cannot monopolize the aggregate budget. */
  maxSnapshotBytes: sharedCacheBudget.maxSnapshotBytes,
  /** Keep the live window bounded even when individual rows are very small. */
  maxMessages: sharedCacheBudget.maxMessages,
  /** Composer text is user-owned working state, bounded independently. */
  maxComposerDraftBytes: sharedCacheBudget.maxComposerDraftBytes,
  maxComposerDraftEntries: sharedCacheBudget.maxComposerDraftEntries,
  maxComposerDraftAggregateBytes: sharedCacheBudget.maxComposerDraftAggregateBytes,
});

export interface CacheMessageSnapshot {
  schema: "butler.message-cache.v1";
  chat_id: string;
  messages: unknown[];
  turn_progress?: Record<string, unknown>;
  next_cursor?: number;
  next_cursor_token?: string;
  cached_at: string;
}

export function cacheSnapshotBytes<T extends CacheMessageSnapshot>(
  snapshot: T | null | undefined,
): number {
  if (!snapshot) return 0;
  try {
    return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Trim only completed message rows. The caller is responsible for excluding
 * active progress and unsent composer state before invoking this helper.
 * Keeps the newest rows that fit. Each row is sized once, so trimming costs
 * one pass over the snapshot however many rows are dropped.
 */
export function trimCacheSnapshot<T extends CacheMessageSnapshot>(
  snapshot: T,
): T | null {
  const progress = snapshot.turn_progress ?? {};
  const recent = snapshot.messages.slice(-APP_CACHE_BUDGET.maxMessages);
  const turns = new Set<string>();
  // Each row also counts one separator, so the sum never undercounts the snapshot.
  let bytes = cacheSnapshotBytes({ ...snapshot, messages: [], turn_progress: {} });
  let start = recent.length;
  while (start > 0) {
    const record = recent[start - 1] as Record<string, unknown>;
    const turnId = typeof record.turn_id === "string" ? record.turn_id : null;
    const turnBytes = turnId && !turns.has(turnId) && turnId in progress
      ? cacheEntryBytes({ [turnId]: progress[turnId] })
      : 0;
    const next = bytes + cacheEntryBytes(record) + 1 + turnBytes;
    if (next > APP_CACHE_BUDGET.maxSnapshotBytes) break;
    bytes = next;
    start -= 1;
    if (turnId) turns.add(turnId);
  }
  if (start === recent.length) return null;
  const turnProgress = Object.fromEntries(
    Object.entries(progress).filter(([turnId]) => turns.has(turnId)),
  );
  return { ...snapshot, messages: recent.slice(start), turn_progress: turnProgress } as T;
}

export function cacheEntryBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
