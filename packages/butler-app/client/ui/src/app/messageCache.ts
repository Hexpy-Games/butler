import type {
  MessageListView,
  MessageRecord,
  TurnProgressSnapshot,
} from "./types.ts";
import {
  mergeMessages,
  mergeTurnProgressSnapshotMap,
} from "./utils.ts";
import {
  freezeConversationActivity as freezeMessageWorkBlocks,
} from "./conversation-progress";
import {
  APP_CACHE_BUDGET,
  cacheSnapshotBytes,
  trimCacheSnapshot,
} from "./cacheBudget.ts";

const MESSAGE_CACHE_SCHEMA = "butler.message-cache.v1";
const MESSAGE_CACHE_PREFIX = "butler:message-cache:v1:";
type CacheRecord = {
  snapshot: MessageCacheSnapshot;
  bytes: number;
};

const localMessageCache = hydrateLocalMessageCache();

interface MessageCacheSnapshot extends MessageListView {
  schema: typeof MESSAGE_CACHE_SCHEMA;
  chat_id: string;
  cached_at: string;
}

interface MessageCacheBridge {
  readCachedMessages?: (input: {
    chatId: string;
  }) => Promise<MessageCacheSnapshot | null>;
  writeCachedMessages?: (input: {
    chatId: string;
    snapshot: MessageCacheSnapshot;
  }) => Promise<unknown>;
}

export function messageListCursor(
  view: Pick<MessageListView, "messages" | "next_cursor">,
): number {
  return Math.max(
    0,
    Number(view.next_cursor ?? 0),
    ...view.messages.map((message) => Number(message.cursor ?? 0)),
  );
}

export function messageListSyncCursor(view: MessageListView): number {
  return messageListCursor(view);
}

export function mergeMessageListViews(
  cached: MessageListView,
  incoming: MessageListView,
): MessageListView {
  const turnProgress = mergeTurnProgressSnapshotMap(
    cached.turn_progress ?? {},
    incoming.turn_progress ?? {},
  );
  const messages = mergeMessages(
    freezeMessageWorkBlocks(cached.messages ?? [], turnProgress),
    freezeMessageWorkBlocks(incoming.messages ?? [], turnProgress),
  );
  const nextCursor = Math.max(
    messageListCursor(cached),
    messageListCursor(incoming),
  );
  if (
    messages === cached.messages &&
    turnProgress === cached.turn_progress &&
    nextCursor === cached.next_cursor &&
    (incoming.chat_id ?? cached.chat_id) === cached.chat_id
  ) {
    return cached;
  }
  return {
    chat_id: incoming.chat_id ?? cached.chat_id,
    messages,
    turn_progress: turnProgress,
    next_cursor: nextCursor,
    ...(incoming.next_cursor_token ?? cached.next_cursor_token
      ? { next_cursor_token: incoming.next_cursor_token ?? cached.next_cursor_token }
      : {}),
  };
}

export async function readCachedMessageList(
  chatId: string,
): Promise<MessageListView | null> {
  const local = normalizeSnapshot(readLocalSnapshot(chatId), chatId);
  const bridge = bridgeCache();
  if (bridge?.readCachedMessages) {
    try {
      const bridged = normalizeSnapshot(
        await bridge.readCachedMessages({ chatId }),
        chatId,
      );
      if (local && bridged) return mergeMessageListViews(local, bridged);
      return bridged ?? local;
    } catch {
      return local;
    }
  }
  return local;
}

export function readCachedMessageListSync(
  chatId: string,
): MessageListView | null {
  return normalizeSnapshot(readLocalSnapshot(chatId), chatId);
}

export async function writeCachedMessageList(
  chatId: string,
  view: MessageListView,
): Promise<void> {
  const snapshot = snapshotForCache(chatId, view);
  if (!snapshot) return;
  writeLocalSnapshot(chatId, snapshot);
  const bridge = bridgeCache();
  if (bridge?.writeCachedMessages) {
    try {
      await bridge.writeCachedMessages({ chatId, snapshot });
    } catch {
      // Cache writes are opportunistic; the renderer mirror is already updated.
    }
  }
}

export function snapshotForCache(
  chatId: string,
  view: MessageListView,
): MessageCacheSnapshot | null {
  const messages = cacheableMessages(
    freezeMessageWorkBlocks(view.messages ?? [], view.turn_progress ?? {}),
  );
  if (messages.length === 0) return null;
  const turnIds = new Set(
    messages.map((message) => message.turn_id).filter(Boolean),
  );
  const turnProgress = Object.fromEntries(
    Object.entries(view.turn_progress ?? {}).filter(
      ([turnId, snapshot]) =>
        turnIds.has(turnId) && isCacheableProgress(snapshot),
    ),
  );
  const snapshot: MessageCacheSnapshot = {
    schema: MESSAGE_CACHE_SCHEMA,
    chat_id: chatId,
    messages,
    turn_progress: turnProgress,
    next_cursor: messageListCursor({ messages, next_cursor: view.next_cursor }),
    ...(view.next_cursor_token
      ? { next_cursor_token: view.next_cursor_token }
      : {}),
    cached_at: new Date().toISOString(),
  };
  return trimCacheSnapshot<MessageCacheSnapshot>(snapshot);
}

function cacheableMessages(messages: MessageRecord[]): MessageRecord[] {
  // Streaming/retrying/pending rows are live working state. Persisting them
  // creates stale durable snapshots after a crash; the active session store
  // remains the owner until the turn reaches a terminal status.
  return messages.filter(
    (message) =>
      message.status !== "pending" &&
      message.status !== "thinking" &&
      message.status !== "streaming" &&
      message.status !== "retrying",
  );
}

function isCacheableProgress(snapshot: TurnProgressSnapshot): boolean {
  return (snapshot.safe_progress_rows ?? []).every(
    (row) =>
      row.state !== "thinking" &&
      row.state !== "running" &&
      row.state !== "streaming" &&
      row.state !== "retrying",
  );
}

function normalizeSnapshot(
  value: unknown,
  chatId: string,
): MessageListView | null {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Partial<MessageCacheSnapshot>;
  if (snapshot.schema !== MESSAGE_CACHE_SCHEMA) return null;
  if (snapshot.chat_id !== chatId) return null;
  if (typeof snapshot.cached_at !== "string") return null;
  if (!Array.isArray(snapshot.messages)) return null;
  const turnProgress = normalizeTurnProgress(snapshot.turn_progress);
  return {
    chat_id: chatId,
    messages: freezeMessageWorkBlocks(
      cacheableMessages(snapshot.messages as MessageRecord[]),
      turnProgress,
    ),
    turn_progress: turnProgress,
    next_cursor: Number(snapshot.next_cursor ?? 0),
    ...(typeof snapshot.next_cursor_token === "string"
      ? { next_cursor_token: snapshot.next_cursor_token }
      : {}),
  };
}

function normalizeTurnProgress(
  value: unknown,
): Record<string, TurnProgressSnapshot> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, TurnProgressSnapshot>;
}

function bridgeCache(): MessageCacheBridge | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as Window & { butlerApp?: MessageCacheBridge }).butlerApp;
}

function readLocalSnapshot(chatId: string): unknown {
  const record = localMessageCache.get(chatId);
  if (!record) return null;
  // Map insertion order is the deterministic LRU order.
  localMessageCache.delete(chatId);
  localMessageCache.set(chatId, record);
  return record.snapshot;
}

function writeLocalSnapshot(
  chatId: string,
  snapshot: MessageCacheSnapshot,
): void {
  const bytes = cacheSnapshotBytes<MessageCacheSnapshot>({
    ...snapshot,
    turn_progress: snapshot.turn_progress ?? {},
  });
  if (!Number.isFinite(bytes) || bytes > APP_CACHE_BUDGET.maxSnapshotBytes) return;
  const existing = localMessageCache.get(chatId);
  if (existing) localMessageCache.delete(chatId);
  localMessageCache.set(chatId, { snapshot, bytes });
  evictLocalMessageCache(chatId);
  try {
    if (localMessageCache.has(chatId)) {
      globalThis.localStorage?.setItem(cacheKey(chatId), JSON.stringify(snapshot));
    } else {
      globalThis.localStorage?.removeItem(cacheKey(chatId));
    }
  } catch {
    // Cache writes are opportunistic and must never block message rendering.
  }
}

function hydrateLocalMessageCache(): Map<string, CacheRecord> {
  const cache = new Map<string, CacheRecord>();
  const candidates: Array<{ chatId: string; snapshot: MessageCacheSnapshot; bytes: number }> = [];
  try {
    const storage = globalThis.localStorage;
    if (!storage) return cache;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(MESSAGE_CACHE_PREFIX)) continue;
      const snapshot = JSON.parse(
        storage.getItem(key) ?? "null",
      ) as Partial<MessageCacheSnapshot> | null;
      if (snapshot?.schema !== MESSAGE_CACHE_SCHEMA || !snapshot.chat_id) {
        continue;
      }
      const normalized = normalizeSnapshot(snapshot, snapshot.chat_id);
      if (!normalized) continue;
      const cacheSnapshot: MessageCacheSnapshot = {
        schema: MESSAGE_CACHE_SCHEMA,
        chat_id: snapshot.chat_id,
        cached_at: snapshot.cached_at!,
        messages: normalized.messages,
        turn_progress: normalized.turn_progress ?? {},
        next_cursor: normalized.next_cursor,
        ...(normalized.next_cursor_token
          ? { next_cursor_token: normalized.next_cursor_token }
          : {}),
      };
      const bytes = cacheSnapshotBytes<MessageCacheSnapshot>(cacheSnapshot);
      if (!Number.isFinite(bytes) || bytes > APP_CACHE_BUDGET.maxSnapshotBytes) {
        storage.removeItem(key);
        continue;
      }
      candidates.push({ chatId: snapshot.chat_id, snapshot: cacheSnapshot, bytes });
    }
    candidates
      .sort((left, right) => {
        const timestamp = Date.parse(left.snapshot.cached_at) - Date.parse(right.snapshot.cached_at);
        return timestamp || left.chatId.localeCompare(right.chatId);
      })
      .forEach(({ chatId, snapshot, bytes }) => cache.set(chatId, { snapshot, bytes }));
    evictCacheMap(cache);
  } catch {
    // Local browser cache hydration is opportunistic.
  }
  return cache;
}

function evictLocalMessageCache(protectedChatId: string): void {
  evictCacheMap(localMessageCache, protectedChatId);
}

function evictCacheMap(
  cache: Map<string, CacheRecord>,
  protectedChatId?: string,
): void {
  const remove = (chatId: string) => {
    cache.delete(chatId);
    try {
      globalThis.localStorage?.removeItem(cacheKey(chatId));
    } catch {
      // Storage cleanup is best effort.
    }
  };
  let totalBytes = [...cache.values()].reduce((total, record) => total + record.bytes, 0);
  while (cache.size > APP_CACHE_BUDGET.maxEntries || totalBytes > APP_CACHE_BUDGET.maxBytes) {
    const candidate = [...cache.keys()].find((chatId) => chatId !== protectedChatId);
    if (!candidate) break;
    const record = cache.get(candidate);
    if (!record) break;
    totalBytes -= record.bytes;
    remove(candidate);
  }
}

function cacheKey(chatId: string): string {
  return `${MESSAGE_CACHE_PREFIX}${encodeURIComponent(chatId)}`;
}
