//! Profile source admission is independent of graph admission and consent.
use super::{CanonicalProfileScan, ProfileResult, storage};
use rusqlite::{OpenFlags, params};
use std::path::Path;

/// Returns future-only message IDs after a profile reset, without hydrating old chats.
/// `None` means no reset boundary exists, preserving the canonical reader path.
pub fn admitted_profile_message_ids(
    root: &Path,
    scan: &CanonicalProfileScan,
) -> ProfileResult<Option<Vec<String>>> {
    if !storage::database_path(root).exists() {
        return Ok(None);
    }
    let owner = storage::open(root, storage::Access::Read)?;
    if !crate::coordination::has_admission_floor(&owner).map_err(storage::io_error)? {
        return Ok(None);
    }
    let canonical = root.join("runtime/conversation-store.sqlite");
    crate::coordination::ensure_data_authority(root, &[&canonical, &storage::database_path(root)])
        .map_err(|error| storage::io_error(std::io::Error::other(error)))?;
    let db = butler_platform::sqlite::open_with_flags(
        &canonical,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(storage::db_error)?;
    let mut uri = url::Url::from_file_path(storage::database_path(root))
        .map_err(|()| storage::io_error(std::io::Error::other("Invalid profile path")))?;
    uri.set_query(Some("mode=ro"));
    db.execute("ATTACH DATABASE ?1 AS profile_floor", [uri.as_str()])
        .map_err(storage::db_error)?;
    let mut query = db.prepare("SELECT m.id FROM conversation_messages m WHERE m.visibility='model' AND m.role='user' AND (?1 IS NULL OR m.created_at>=?1)
        AND NOT EXISTS(SELECT 1 FROM profile_floor.memory_reset_admissions a WHERE a.kind='message' AND a.id=m.id)
        AND NOT EXISTS(SELECT 1 FROM profile_floor.memory_reset_admissions a WHERE a.kind='turn' AND a.id=m.turn_id)
        ORDER BY m.created_at,m.seq,m.id LIMIT ?2 OFFSET ?3").map_err(storage::db_error)?;
    let ids = query
        .query_map(
            params![
                scan.since,
                butler_core::json::saturating_u64(scan.limit.clamp(1.0, 5000.0)),
                butler_core::json::saturating_u64(scan.offset.max(0.0))
            ],
            |row| row.get(0),
        )
        .map_err(storage::db_error)?
        .collect::<Result<Vec<String>, _>>()
        .map_err(storage::db_error)?;
    Ok(Some(ids))
}

/// Whether a canonical message remains eligible after the latest profile reset.
pub fn profile_message_is_admitted(root: &Path, id: &str) -> ProfileResult<bool> {
    if !storage::database_path(root).exists() {
        return Ok(true);
    }
    let db = storage::open(root, storage::Access::Read)?;
    crate::coordination::admission_suppressed(&db, "message", id)
        .map(|suppressed| !suppressed)
        .map_err(storage::io_error)
}
