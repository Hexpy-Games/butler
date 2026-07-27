import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import { sessionHintForRow } from
  "../../domain/sessions/session-read-model.ts";
import { transcriptPathFromDataHome } from
  "../../domain/sessions/transcript-reader.ts";

export function resolveAppTranscriptChatId(
  db: Database,
  butlerData: string,
  fileName: string,
): string | null {
  const prefix = "butler_app-";
  const suffix = ".jsonl";
  if (!fileName.startsWith(prefix) || !fileName.endsWith(suffix)) return null;
  const candidate = fileName.slice(prefix.length, -suffix.length);
  const row = db.query<{ id: string }, [string]>(`
    SELECT id FROM chats WHERE id = ?
  `).get(candidate);
  if (!row) return null;
  const path = transcriptPathFromDataHome(
    butlerData,
    sessionHintForRow(row.id),
  );
  return basename(path) === fileName ? row.id : null;
}

export function listOpenTurnTranscriptFiles(
  db: Database,
  butlerData: string,
): string[] {
  const rows = db.query<{ chat_id: string }, []>(`
    SELECT DISTINCT chat_id FROM turns
    WHERE state IN (
      'queued', 'accepted', 'thinking', 'streaming', 'waiting_for_form',
      'waiting_for_tool', 'cancelling', 'retrying'
    )
  `).all();
  return rows.map((row) => basename(transcriptPathFromDataHome(
    butlerData,
    sessionHintForRow(row.chat_id),
  )));
}
