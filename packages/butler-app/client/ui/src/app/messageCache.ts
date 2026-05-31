import type {
  MessageListView,
  MessageRecord,
  TurnProgressSnapshot,
} from "./types.ts";
import {
  freezeMessageWorkBlocks,
  mergeMessages,
  mergeTurnProgressSnapshotMap,
} from "./utils.ts";

const MESSAGE_CACHE_SCHEMA = "butler.message-cache.v1";
const MESSAGE_CACHE_PREFIX = "butler:message-cache:v1:";
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
  return {
    schema: MESSAGE_CACHE_SCHEMA,
    chat_id: chatId,
    messages,
    turn_progress: turnProgress,
    next_cursor: messageListCursor({ messages, next_cursor: view.next_cursor }),
    cached_at: new Date().toISOString(),
  };
}

function cacheableMessages(messages: MessageRecord[]): MessageRecord[] {
  return messages.filter((message) => message.status !== "pending");
}

function isCacheableProgress(snapshot: TurnProgressSnapshot): boolean {
  return (snapshot.safe_progress_rows ?? []).every(
    (row) => row.state !== "thinking" && row.state !== "running",
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
  return localMessageCache.get(chatId) ?? null;
}

function writeLocalSnapshot(
  chatId: string,
  snapshot: MessageCacheSnapshot,
): void {
  localMessageCache.set(chatId, snapshot);
  try {
    globalThis.localStorage?.setItem(
      cacheKey(chatId),
      JSON.stringify(snapshot),
    );
  } catch {
    // Cache writes are opportunistic and must never block message rendering.
  }
}

function hydrateLocalMessageCache(): Map<string, unknown> {
  const cache = new Map<string, unknown>();
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
      cache.set(snapshot.chat_id, snapshot);
    }
  } catch {
    // Local browser cache hydration is opportunistic.
  }
  return cache;
}

function cacheKey(chatId: string): string {
  return `${MESSAGE_CACHE_PREFIX}${encodeURIComponent(chatId)}`;
}
