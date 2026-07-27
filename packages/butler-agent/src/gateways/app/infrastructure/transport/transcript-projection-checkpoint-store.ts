import type { Database } from "bun:sqlite";

export type TranscriptProjectionCheckpoint = {
  chatId: string;
  sessionId: string;
  path: string;
  device: number;
  inode: number;
  projectedBytes: number;
  modifiedAtMs: number;
  trailing: Buffer;
  boundaryAnchor: Buffer;
  spoolPath: string;
  spoolBytes: number;
  spoolEndOffset: number;
};

export class TranscriptProjectionCheckpointStore {
  constructor(private readonly db: Database) {}

  load(chatId: string): TranscriptProjectionCheckpoint | null {
    const row = this.db.query<{
      chat_id: string;
      session_id: string;
      transcript_path: string;
      file_device: number;
      file_inode: number;
      projected_bytes: number;
      modified_at_ms: number;
      trailing_text: string;
      boundary_anchor_text: string;
      spool_path: string;
      spool_bytes: number;
      spool_end_offset: number;
    }, [string]>(`
      SELECT chat_id, session_id, transcript_path, file_device, file_inode,
        projected_bytes, modified_at_ms, trailing_text, boundary_anchor_text,
        spool_path, spool_bytes, spool_end_offset
      FROM app_transcript_projection_checkpoints
      WHERE chat_id = ?
    `).get(chatId);
    return row
      ? {
          chatId: row.chat_id,
          sessionId: row.session_id,
          path: row.transcript_path,
          device: row.file_device,
          inode: row.file_inode,
          projectedBytes: row.projected_bytes,
          modifiedAtMs: row.modified_at_ms,
          trailing: Buffer.from(row.trailing_text, "base64"),
          boundaryAnchor: Buffer.from(row.boundary_anchor_text, "base64"),
          spoolPath: row.spool_path,
          spoolBytes: row.spool_bytes,
          spoolEndOffset: row.spool_end_offset,
        }
      : null;
  }

  save(checkpoint: TranscriptProjectionCheckpoint): void {
    this.db.query(`
      INSERT INTO app_transcript_projection_checkpoints (
        chat_id, session_id, transcript_path, file_device, file_inode,
        projected_bytes, modified_at_ms, trailing_text, boundary_anchor_text,
        spool_path, spool_bytes, spool_end_offset, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        session_id = excluded.session_id,
        transcript_path = excluded.transcript_path,
        file_device = excluded.file_device,
        file_inode = excluded.file_inode,
        projected_bytes = excluded.projected_bytes,
        modified_at_ms = excluded.modified_at_ms,
        trailing_text = excluded.trailing_text,
        boundary_anchor_text = excluded.boundary_anchor_text,
        spool_path = excluded.spool_path,
        spool_bytes = excluded.spool_bytes,
        spool_end_offset = excluded.spool_end_offset,
        updated_at = excluded.updated_at
    `).run(
      checkpoint.chatId,
      checkpoint.sessionId,
      checkpoint.path,
      checkpoint.device,
      checkpoint.inode,
      checkpoint.projectedBytes,
      checkpoint.modifiedAtMs,
      checkpoint.trailing.toString("base64"),
      checkpoint.boundaryAnchor.toString("base64"),
      checkpoint.spoolPath,
      checkpoint.spoolBytes,
      checkpoint.spoolEndOffset,
      new Date().toISOString(),
    );
  }
}
