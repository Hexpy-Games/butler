//! Read-only metadata over the same delivered attachment relations as the dashboard.
use std::path::Path;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use butler_core::public_text::sanitize_public_text;
use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "type")]
    pub file_type: String,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
    pub read_handle: Option<Handle>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Handle {
    pub id: String,
    pub revision: String,
}

#[derive(Deserialize, Serialize)]
struct Cursor {
    project: String,
    name: String,
    file_type: String,
    rank: i64,
    rowid: i64,
    id: String,
    revision: String,
}

pub(super) struct Artifact {
    pub id: String,
    pub revision: String,
    pub size: u64,
    pub value: Value,
    rank: i64,
    rowid: i64,
}

// Group by registration, not title: distinct deliverables can share a name.
// Reattachments retain a stable file id and expose only their latest delivered origin.
const CANDIDATES: &str = "WITH origins AS (\
    SELECT a.file_id,MAX(m.rowid) AS latest FROM chats c \
    JOIN messages m ON m.chat_id=c.id \
    JOIN message_attachments a ON a.message_id=m.id \
    WHERE c.project_id=?1 AND m.role='assistant' AND m.status='delivered' \
    AND (m.safe_error_code IS NULL OR m.safe_error_code NOT IN \
    ('app_turn_queue_failed','goal_completion_incomplete')) GROUP BY a.file_id), \
    matches AS (SELECT f.*,m.rowid AS origin_rowid,m.chat_id,m.turn_id,m.id AS origin_message,\
    CASE WHEN lower(f.safe_name)=lower(?2) AND ?2<>'' THEN 0 ELSE 1 END AS match_rank \
    FROM origins o JOIN message_files f ON f.id=o.file_id \
    JOIN messages m ON m.rowid=o.latest \
    WHERE (?2='' OR instr(lower(f.safe_name),lower(?2))>0) \
    AND f.storage_name=f.id \
    AND (?3='' OR lower(f.mime_type)=lower(?3) OR lower(f.kind)=lower(?3)) \
    AND (?4='' OR f.id=?4)) ";

pub(super) fn open(root: &Path, signal: CancellationToken) -> rusqlite::Result<Connection> {
    // Read-only flags must never create a DB or mutate a refused data root.
    let db = butler_platform::sqlite::open_with_flags(
        root.join("app-server/butler-client.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    db.progress_handler(1000, Some(move || signal.is_cancelled()));
    db.busy_timeout(std::time::Duration::ZERO)?;
    Ok(db)
}

pub(super) fn page(
    root: &Path,
    project: &str,
    request: &Request,
    signal: CancellationToken,
) -> Result<Value, String> {
    let limit = request.limit.unwrap_or(50);
    if !(1..=100).contains(&limit)
        || request.read_handle.is_some()
        || request.name.len() > 1024
        || request.file_type.len() > 128
    {
        return Err("invalid_arguments".into());
    }
    let cursor = decode_cursor(project, request)?;
    let mut db = open(root, signal).map_err(|_| "artifact_index_unavailable")?;
    let tx = db.transaction().map_err(|_| "artifact_index_unavailable")?;
    let (total, revision) = matching_state(&tx, project, request)?;
    if cursor.as_ref().is_some_and(|c| c.revision != revision) {
        return Err("source_changed".into());
    }
    let (rank, rowid, id) = cursor
        .as_ref()
        .map_or((-1, i64::MAX, ""), |c| (c.rank, c.rowid, c.id.as_str()));
    let sql = format!(
        "{CANDIDATES} SELECT * FROM matches WHERE \
        match_rank>?5 OR (match_rank=?5 AND (origin_rowid<?6 OR \
        (origin_rowid=?6 AND id<?7))) \
        ORDER BY match_rank,origin_rowid DESC,id DESC LIMIT ?8"
    );
    let mut statement = tx.prepare(&sql).map_err(|_| "artifact_index_unavailable")?;
    let rows = statement
        .query_map(
            params![
                project,
                request.name,
                request.file_type,
                "",
                rank,
                rowid,
                id,
                limit + 1
            ],
            artifact,
        )
        .map_err(|_| "artifact_index_unavailable")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "artifact_index_unavailable")?;
    page_value(project, request, &rows, limit, total, &revision)
}

fn page_value(
    project: &str,
    request: &Request,
    rows: &[Artifact],
    limit: usize,
    total: u64,
    revision: &str,
) -> Result<Value, String> {
    // Fit complete items into the existing 50 KiB provider result budget.
    // A smaller page is continuation, never omission of fields or matches.
    let mut bytes = 0;
    let selected: Vec<_> = rows
        .iter()
        .take(limit)
        .take_while(|row| {
            bytes += row.value.to_string().len();
            bytes <= 42 * 1024
        })
        .collect();
    if selected.is_empty() && !rows.is_empty() {
        return Err("context_overflow".into());
    }
    let next = if rows.len() > selected.len() {
        let last = selected.last().ok_or("context_overflow")?;
        Some(
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&Cursor {
                    project: project.into(),
                    name: request.name.clone(),
                    file_type: request.file_type.clone(),
                    rank: last.rank,
                    rowid: last.rowid,
                    id: last.id.clone(),
                    revision: revision.into(),
                })
                .map_err(|_| "invalid_cursor")?,
            ),
        )
    } else {
        None
    };
    Ok(
        json!({"ok":true,"total_count":total,"items":selected.iter().map(|a| &a.value).collect::<Vec<_>>(),"next_cursor":next}),
    )
}

fn matching_state(
    db: &Connection,
    project: &str,
    request: &Request,
) -> Result<(u64, String), String> {
    let sql = format!(
        "{CANDIDATES} SELECT id,sha256,safe_name,mime_type,kind,\
        size_bytes,origin_rowid,chat_id,turn_id,origin_message,match_rank \
        FROM matches ORDER BY id"
    );
    let mut statement = db.prepare(&sql).map_err(|_| "artifact_index_unavailable")?;
    let mut rows = statement
        .query(params![project, request.name, request.file_type, ""])
        .map_err(|_| "artifact_index_unavailable")?;
    let mut count = 0;
    let mut digest = Sha256::new();
    while let Some(row) = rows.next().map_err(|_| "artifact_index_unavailable")? {
        for column in 0..11 {
            match row
                .get_ref(column)
                .map_err(|_| "artifact_index_unavailable")?
            {
                rusqlite::types::ValueRef::Null => digest.update([0]),
                rusqlite::types::ValueRef::Integer(value) => {
                    digest.update([1]);
                    digest.update(value.to_le_bytes());
                }
                rusqlite::types::ValueRef::Text(bytes) => {
                    digest.update([2]);
                    digest.update((bytes.len() as u64).to_le_bytes());
                    digest.update(bytes);
                }
                _ => return Err("artifact_index_unavailable".into()),
            }
        }
        count += 1;
    }
    Ok((count, format!("{:x}", digest.finalize())))
}

pub(super) fn find(
    root: &Path,
    project: &str,
    id: &str,
    signal: CancellationToken,
) -> Result<Option<Artifact>, String> {
    let db = open(root, signal).map_err(|_| "artifact_index_unavailable")?;
    let mut statement = db
        .prepare(&format!("{CANDIDATES} SELECT * FROM matches"))
        .map_err(|_| "artifact_index_unavailable")?;
    let mut rows = statement
        .query_map(params![project, "", "", id], artifact)
        .map_err(|_| "artifact_index_unavailable")?;
    rows.next()
        .transpose()
        .map_err(|_| "artifact_index_unavailable".into())
}

fn artifact(row: &rusqlite::Row<'_>) -> rusqlite::Result<Artifact> {
    let id: String = row.get("id")?;
    let revision: String = row.get("sha256")?;
    let size: u64 = row.get("size_bytes")?;
    let title: String = row.get("safe_name")?;
    let value = json!({
        "id":id,"title":sanitize_public_text(&title, ""),
        "type":row.get::<_,String>("mime_type")?,"kind":row.get::<_,String>("kind")?,
        "size_bytes":size,"origin_session":row.get::<_,String>("chat_id")?,
        "origin_turn":row.get::<_,Option<String>>("turn_id")?,
        "origin_message":row.get::<_,String>("origin_message")?,
        "read_handle":{"id":id,"revision":revision},
    });
    Ok(Artifact {
        id,
        revision,
        size,
        value,
        rank: row.get("match_rank")?,
        rowid: row.get("origin_rowid")?,
    })
}

fn decode_cursor(project: &str, request: &Request) -> Result<Option<Cursor>, String> {
    let Some(raw) = request.cursor.as_deref().filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if raw.len() > 4096 {
        return Err("invalid_cursor".into());
    }
    let c: Cursor = URL_SAFE_NO_PAD
        .decode(raw)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or("invalid_cursor")?;
    if c.project != project || c.name != request.name || c.file_type != request.file_type {
        return Err("invalid_cursor".into());
    }
    Ok(Some(c))
}
