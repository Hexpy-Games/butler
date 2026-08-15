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
 */
export function trimCacheSnapshot<T extends CacheMessageSnapshot>(
  snapshot: T,
): T | null {
  let messages = snapshot.messages.slice(-APP_CACHE_BUDGET.maxMessages);
  const retainedIds = new Set(
    messages
      .map((message) => {
        const record = message as Record<string, unknown>;
        return typeof record.turn_id === "string" ? record.turn_id : null;
      })
      .filter((turnId): turnId is string => Boolean(turnId)),
  );
  let turnProgress = Object.fromEntries(
    Object.entries(snapshot.turn_progress ?? {}).filter(([turnId]) =>
      retainedIds.has(turnId),
    ),
  );
  let candidate = { ...snapshot, messages, turn_progress: turnProgress } as T;
  while (
    messages.length > 0 &&
    cacheSnapshotBytes(candidate) > APP_CACHE_BUDGET.maxSnapshotBytes
  ) {
    messages = messages.slice(1);
    const nextIds = new Set(
      messages
        .map((message) => {
          const record = message as Record<string, unknown>;
          return typeof record.turn_id === "string" ? record.turn_id : null;
        })
        .filter((turnId): turnId is string => Boolean(turnId)),
    );
    turnProgress = Object.fromEntries(
      Object.entries(turnProgress).filter(([turnId]) => nextIds.has(turnId)),
    );
    candidate = { ...snapshot, messages, turn_progress: turnProgress } as T;
  }
  return (
    messages.length > 0 &&
    cacheSnapshotBytes(candidate) <= APP_CACHE_BUDGET.maxSnapshotBytes
  )
    ? candidate
    : null;
}

export function cacheEntryBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
