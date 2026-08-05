export interface ComposerDraftFileSnapshot {
  schema: "butler.composer-draft.v1";
  session_id: string;
  text: string;
  updated_at: string;
}

export function composerDraftFilePath(
  directory: string,
  sessionId: string,
): string;

export function readComposerDraftFile(
  directory: string,
  sessionId: string,
): ComposerDraftFileSnapshot | null;

export function writeComposerDraftFile(
  directory: string,
  value: unknown,
): { ok: boolean };
