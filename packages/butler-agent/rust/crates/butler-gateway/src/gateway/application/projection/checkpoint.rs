//! Durable transcript byte boundary identity.

use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OptionalExtension, params};

use super::super::storage::AppStorageError;

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Checkpoint {
    pub chat_id: String,
    pub session_id: String,
    pub path: String,
    pub device: u64,
    pub inode: u64,
    pub projected_bytes: u64,
    // Bun persists fs.stat.mtimeMs, which can be a fractional SQLite REAL.
    pub modified_at_ms: f64,
    pub trailing: Vec<u8>,
    pub boundary_anchor: Vec<u8>,
    pub spool_path: String,
    pub spool_bytes: u64,
    pub spool_end_offset: u64,
}

/// `trailing` holds at most one byte window plus one partial record. Checkpoints
/// written by the native cutover before the window was bounded kept the whole
/// rest of the transcript here (tens of MB). Loading drops a longer value and
/// the file is read again from `projected_bytes`: the next read starts at
/// `projected_bytes + trailing.len()`, where the file still holds those bytes.
const MAX_TRAILING_BYTES: usize = 128 * 1024;

pub(super) fn load(db: &Connection, chat_id: &str) -> Result<Option<Checkpoint>, AppStorageError> {
    let oversized = db
        .query_row(
            "SELECT length(trailing_text)>?2 FROM app_transcript_projection_checkpoints \
             WHERE chat_id=?1",
            params![chat_id, MAX_TRAILING_BYTES.div_ceil(3) * 4],
            |row| row.get::<_, bool>(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if oversized == Some(true) {
        db.execute(
            "UPDATE app_transcript_projection_checkpoints SET trailing_text='' WHERE chat_id=?1",
            [chat_id],
        )
        .map_err(AppStorageError::sqlite)?;
    }
    db.query_row(
        "SELECT chat_id,session_id,transcript_path,file_device,file_inode,projected_bytes,\
         modified_at_ms,trailing_text,boundary_anchor_text,spool_path,spool_bytes,spool_end_offset \
         FROM app_transcript_projection_checkpoints WHERE chat_id=?1",
        [chat_id],
        |row| {
            Ok(Checkpoint {
                chat_id: row.get(0)?,
                session_id: row.get(1)?,
                path: row.get(2)?,
                device: row.get(3)?,
                inode: row.get(4)?,
                projected_bytes: row.get(5)?,
                modified_at_ms: row.get(6)?,
                trailing: decode(&row.get::<_, String>(7)?),
                boundary_anchor: decode(&row.get::<_, String>(8)?),
                spool_path: row.get(9)?,
                spool_bytes: row.get(10)?,
                spool_end_offset: row.get(11)?,
            })
        },
    )
    .optional()
    .map_err(AppStorageError::sqlite)
}

pub(super) fn save(db: &Connection, value: &Checkpoint, now: &str) -> Result<(), AppStorageError> {
    db.execute(
        "INSERT INTO app_transcript_projection_checkpoints(chat_id,session_id,transcript_path,\
         file_device,file_inode,projected_bytes,modified_at_ms,trailing_text,boundary_anchor_text,\
         spool_path,spool_bytes,spool_end_offset,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,\
         ?8,?9,?10,?11,?12,?13) ON CONFLICT(chat_id) DO UPDATE SET session_id=excluded.session_id,\
         transcript_path=excluded.transcript_path,file_device=excluded.file_device,file_inode=excluded.file_inode,\
         projected_bytes=excluded.projected_bytes,modified_at_ms=excluded.modified_at_ms,\
         trailing_text=excluded.trailing_text,boundary_anchor_text=excluded.boundary_anchor_text,\
         spool_path=excluded.spool_path,spool_bytes=excluded.spool_bytes,\
         spool_end_offset=excluded.spool_end_offset,updated_at=excluded.updated_at",
        params![value.chat_id,value.session_id,value.path,value.device,value.inode,
            value.projected_bytes,value.modified_at_ms,encode(&value.trailing),
            encode(&value.boundary_anchor),value.spool_path,value.spool_bytes,
            value.spool_end_offset,now],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}

fn encode(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// Unreadable text decodes to nothing: the bytes are then read again from
/// the transcript, which is where they came from.
fn decode(value: &str) -> Vec<u8> {
    STANDARD.decode(value).unwrap_or_default()
}
