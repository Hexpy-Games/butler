import { APP_CACHE_BUDGET } from "./cacheBudget.ts";

const COMPOSER_DRAFT_SCHEMA = "butler.composer-draft.v1";
const COMPOSER_DRAFT_KEY_PREFIX = "butler:composer-draft:v1:";

export interface ComposerDraftSnapshot {
  schema: typeof COMPOSER_DRAFT_SCHEMA;
  session_id: string;
  text: string;
  updated_at: string;
}

interface ComposerDraftBridge {
  readCachedComposerDraft?: (input: { sessionId: string }) => Promise<unknown>;
  writeCachedComposerDraft?: (input: {
    snapshot: ComposerDraftSnapshot;
  }) => Promise<unknown>;
}

export function composerDraftSnapshot(
  sessionId: string,
  text: string,
  updatedAt = new Date().toISOString(),
): ComposerDraftSnapshot {
  return {
    schema: COMPOSER_DRAFT_SCHEMA,
    session_id: sessionId,
    text,
    updated_at: updatedAt,
  };
}

export function normalizeComposerDraft(
  value: unknown,
  expectedSessionId: string,
): ComposerDraftSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const draft = value as Partial<ComposerDraftSnapshot>;
  if (
    draft.schema !== COMPOSER_DRAFT_SCHEMA ||
    draft.session_id !== expectedSessionId ||
    typeof draft.text !== "string" ||
    typeof draft.updated_at !== "string" ||
    !Number.isFinite(Date.parse(draft.updated_at)) ||
    !draftTextWithinBudget(draft.text)
  ) return null;
  return draft as ComposerDraftSnapshot;
}

export function newestComposerDraft(
  immediate: ComposerDraftSnapshot | null,
  durable: ComposerDraftSnapshot | null,
): ComposerDraftSnapshot | null {
  if (!immediate) return durable;
  if (!durable) return immediate;
  return Date.parse(durable.updated_at) > Date.parse(immediate.updated_at)
    ? durable
    : immediate;
}

export function readLocalComposerDraft(
  sessionId: string,
): ComposerDraftSnapshot | null {
  try {
    const raw = globalThis.localStorage?.getItem(localKey(sessionId));
    return normalizeComposerDraft(raw ? JSON.parse(raw) : null, sessionId);
  } catch {
    return null;
  }
}

export function writeLocalComposerDraft(snapshot: ComposerDraftSnapshot): void {
  const normalized = normalizeComposerDraft(snapshot, snapshot.session_id);
  if (!normalized) return;
  try {
    globalThis.localStorage?.setItem(
      localKey(normalized.session_id),
      JSON.stringify(normalized),
    );
    evictLocalComposerDrafts(normalized.session_id);
  } catch {
    // The Electron cache remains available when origin storage is unavailable.
  }
}

export async function readCachedComposerDraft(
  sessionId: string,
): Promise<ComposerDraftSnapshot | null> {
  const immediate = readLocalComposerDraft(sessionId);
  try {
    const value = await composerDraftBridge()?.readCachedComposerDraft?.({
      sessionId,
    });
    return newestComposerDraft(
      immediate,
      normalizeComposerDraft(value, sessionId),
    );
  } catch {
    return immediate;
  }
}

export function writeCachedComposerDraft(
  sessionId: string,
  text: string,
): ComposerDraftSnapshot | null {
  const snapshot = composerDraftSnapshot(sessionId, text);
  if (!normalizeComposerDraft(snapshot, sessionId)) return null;
  writeLocalComposerDraft(snapshot);
  void composerDraftBridge()?.writeCachedComposerDraft?.({ snapshot }).catch(
    () => undefined,
  );
  return snapshot;
}

function draftTextWithinBudget(text: string): boolean {
  try {
    return new TextEncoder().encode(text).byteLength <=
      APP_CACHE_BUDGET.maxComposerDraftBytes;
  } catch {
    return false;
  }
}

function evictLocalComposerDrafts(protectedSessionId: string): void {
  const storage = globalThis.localStorage;
  if (!storage) return;
  const candidates: Array<{
    key: string;
    sessionId: string;
    bytes: number;
    updatedAt: number;
  }> = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(COMPOSER_DRAFT_KEY_PREFIX)) continue;
      const raw = storage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as unknown;
      const sessionId = typeof parsed === "object" && parsed !== null &&
          !Array.isArray(parsed) && typeof (parsed as { session_id?: unknown }).session_id === "string"
        ? (parsed as { session_id: string }).session_id
        : "";
      const normalized = normalizeComposerDraft(parsed, sessionId);
      if (!normalized) {
        storage.removeItem(key);
        continue;
      }
      candidates.push({
        key,
        sessionId,
        bytes: new TextEncoder().encode(raw).byteLength,
        updatedAt: Date.parse(normalized.updated_at),
      });
    }
    candidates.sort((left, right) =>
      left.updatedAt - right.updatedAt || left.key.localeCompare(right.key),
    );
    let totalBytes = candidates.reduce((total, candidate) => total + candidate.bytes, 0);
    let count = candidates.length;
    for (const candidate of candidates) {
      if (
        count <= APP_CACHE_BUDGET.maxComposerDraftEntries &&
        totalBytes <= APP_CACHE_BUDGET.maxComposerDraftAggregateBytes
      ) break;
      if (candidate.sessionId === protectedSessionId) continue;
      storage.removeItem(candidate.key);
      count -= 1;
      totalBytes -= candidate.bytes;
    }
  } catch {
    // Storage is opportunistic; failed enumeration must not block typing.
  }
}

function localKey(sessionId: string): string {
  return `${COMPOSER_DRAFT_KEY_PREFIX}${encodeURIComponent(sessionId)}`;
}

function composerDraftBridge(): ComposerDraftBridge | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as Window & { butlerApp?: ComposerDraftBridge }).butlerApp;
}
