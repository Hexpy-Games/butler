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
    !Number.isFinite(Date.parse(draft.updated_at))
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
  try {
    globalThis.localStorage?.setItem(
      localKey(snapshot.session_id),
      JSON.stringify(snapshot),
    );
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
): ComposerDraftSnapshot {
  const snapshot = composerDraftSnapshot(sessionId, text);
  writeLocalComposerDraft(snapshot);
  void composerDraftBridge()?.writeCachedComposerDraft?.({ snapshot }).catch(
    () => undefined,
  );
  return snapshot;
}

function localKey(sessionId: string): string {
  return `${COMPOSER_DRAFT_KEY_PREFIX}${encodeURIComponent(sessionId)}`;
}

function composerDraftBridge(): ComposerDraftBridge | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as Window & { butlerApp?: ComposerDraftBridge }).butlerApp;
}
