//! Durable transcript byte boundary identity.

use rusqlite::{Connection, OptionalExtension, params};

use super::super::storage::AppStorageError;

#[derive(Clone, Debug)]
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

pub(super) fn load(db: &Connection, chat_id: &str) -> Result<Option<Checkpoint>, AppStorageError> {
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

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
fn encode(bytes: &[u8]) -> String {
    let mut result = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        result.push(ALPHABET[((value >> 18) & 63) as usize] as char);
        result.push(ALPHABET[((value >> 12) & 63) as usize] as char);
        result.push(if chunk.len() > 1 {
            ALPHABET[((value >> 6) & 63) as usize] as char
        } else {
            '='
        });
        result.push(if chunk.len() > 2 {
            ALPHABET[(value & 63) as usize] as char
        } else {
            '='
        });
    }
    result
}
fn decode(value: &str) -> Vec<u8> {
    let mut output = Vec::with_capacity(value.len() / 4 * 3);
    for chunk in value.as_bytes().chunks_exact(4) {
        let Some(a) = index(chunk[0]) else {
            return Vec::new();
        };
        let Some(b) = index(chunk[1]) else {
            return Vec::new();
        };
        let c = if chunk[2] == b'=' {
            0
        } else if let Some(v) = index(chunk[2]) {
            v
        } else {
            return Vec::new();
        };
        let d = if chunk[3] == b'=' {
            0
        } else if let Some(v) = index(chunk[3]) {
            v
        } else {
            return Vec::new();
        };
        let bits = (u32::from(a) << 18) | (u32::from(b) << 12) | (u32::from(c) << 6) | u32::from(d);
        output.push((bits >> 16) as u8);
        if chunk[2] != b'=' {
            output.push((bits >> 8) as u8);
        }
        if chunk[3] != b'=' {
            output.push(bits as u8);
        }
    }
    output
}
fn index(byte: u8) -> Option<u8> {
    ALPHABET
        .iter()
        .position(|candidate| *candidate == byte)
        .map(|value| value as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_fractional_bun_mtime_from_existing_checkpoint() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE app_transcript_projection_checkpoints( \
               chat_id TEXT,session_id TEXT,transcript_path TEXT,file_device INTEGER, \
               file_inode INTEGER,projected_bytes INTEGER,modified_at_ms INTEGER, \
               trailing_text TEXT,boundary_anchor_text TEXT,spool_path TEXT, \
               spool_bytes INTEGER,spool_end_offset INTEGER); \
             INSERT INTO app_transcript_projection_checkpoints VALUES( \
               'general','butler/app-general','/scratch/transcript',1,2,17, \
               1789313577777.5864,'','','',0,0);",
        )
        .unwrap();
        let checkpoint = load(&db, "general").unwrap().unwrap();
        assert_eq!(checkpoint.projected_bytes, 17);
        assert_eq!(checkpoint.modified_at_ms, 1789313577777.5864);
    }
}
