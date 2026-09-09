export interface ComposerDraftFileSnapshot {
  schema: "butler.composer-draft.v1";
  session_id: string;
  text: string;
  content_parts?: import("../../../butler-agent/src/foundation/message-content.ts").MessageContent;
  updated_at: string;
}

export interface ComposerDraftCacheOptions {
  maxBytes?: number;
  maxEntries?: number;
  maxAggregateBytes?: number;
}

export function composerDraftFilePath(
  directory: string,
  sessionId: string,
): string;

export function readComposerDraftFile(
  directory: string,
  sessionId: string,
  options?: ComposerDraftCacheOptions,
): ComposerDraftFileSnapshot | null;

export function writeComposerDraftFile(
  directory: string,
  value: unknown,
  options?: ComposerDraftCacheOptions,
): { ok: boolean };
