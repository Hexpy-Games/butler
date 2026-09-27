//! The rebuildable SQLite index over the box item manifests.

use std::{fs, path::Path};

use rusqlite::{Connection, Transaction, params};
use serde::Serialize;
use serde_json::Value;

use crate::cognition::{CognitionError, CognitionResult};

use super::{error, index_io, manifest, paths};
use crate::cognition::CognitionCode;
use manifest::BoxManifest;

const INDEX_REPORT_SCHEMA: &str = "butler.cognition.box.index-rebuild-report.v1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BoxIndexReport {
    pub schema: &'static str,
    pub rebuilt_at: String,
    pub status: &'static str,
    pub indexed_count: usize,
    pub skipped_count: usize,
    pub skipped: Vec<BoxIndexSkip>,
    pub index_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BoxIndexSkip {
    pub path: String,
    pub issues: Vec<String>,
}

/// Rebuilds `index.sqlite` from the item manifests, replacing the old
/// index only once the new one is complete, and writes the rebuild report.
pub(super) fn rebuild_index(root: &Path) -> CognitionResult<BoxIndexReport> {
    index_io::create_private_dir(root)?;
    let temporary = root.join(format!("index.sqlite.tmp-{}", uuid::Uuid::new_v4()));
    let result = build(root, &temporary);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        if let Some(name) = temporary.file_name().and_then(|name| name.to_str()) {
            let journal = temporary.with_file_name(format!("{name}-journal"));
            let _ = fs::remove_file(journal);
        }
    }
    result
}

fn build(root: &Path, temporary: &Path) -> CognitionResult<BoxIndexReport> {
    let index_path = root.join("index.sqlite");
    let report_path = root.join("index-rebuild-report.json");
    index_io::create_private_file(temporary)?;
    let mut database = Connection::open(temporary)
        .map_err(|source| error(CognitionCode::MemoryBoxIndexWriteFailed).with_source(source))?;
    create_schema(&database)?;
    let mut indexing = Indexing::default();
    if paths::canonical_items_root(root)?.is_some() {
        indexing.items(root, &mut database)?;
    }
    database.close().map_err(|(_, source)| {
        error(CognitionCode::MemoryBoxIndexWriteFailed).with_source(source)
    })?;
    fs::rename(temporary, &index_path)
        .map_err(|source| error(CognitionCode::MemoryBoxIndexWriteFailed).with_source(source))?;
    let report = BoxIndexReport {
        schema: INDEX_REPORT_SCHEMA,
        rebuilt_at: index_io::now_iso(),
        status: if indexing.skipped.is_empty() {
            "ok"
        } else {
            "partial"
        },
        indexed_count: indexing.indexed_count,
        skipped_count: indexing.skipped.len(),
        skipped: indexing.skipped,
        index_path: index_path.to_string_lossy().into_owned(),
    };
    index_io::write_report(&report_path, &report)?;
    Ok(report)
}

/// Items indexed so far and the manifests that could not be.
#[derive(Default)]
struct Indexing {
    indexed_count: usize,
    skipped: Vec<BoxIndexSkip>,
}

impl Indexing {
    fn items(&mut self, root: &Path, database: &mut Connection) -> CognitionResult<()> {
        let read_failed = |source: std::io::Error| {
            error(CognitionCode::MemoryBoxItemsReadFailed).with_source(source)
        };
        for entry in fs::read_dir(root.join("items")).map_err(read_failed)? {
            let entry = entry.map_err(read_failed)?;
            if entry.file_type().map_err(read_failed)?.is_dir() {
                self.item(root, database, &entry)?;
            }
        }
        Ok(())
    }

    /// Indexes one item directory in its own transaction; an invalid
    /// manifest or a failed insert is recorded as skipped.
    fn item(
        &mut self,
        root: &Path,
        database: &mut Connection,
        entry: &fs::DirEntry,
    ) -> CognitionResult<()> {
        let item_dir = entry.path();
        let manifest_path = item_dir.join("manifest.json");
        let expected_id = entry.file_name().to_string_lossy().into_owned();
        let manifest = match manifest::read_manifest_for_dir(root, &item_dir, &expected_id) {
            Ok(Some(manifest)) => manifest,
            Ok(None) => return Ok(()),
            Err(error) => {
                self.skipped.push(BoxIndexSkip {
                    path: manifest_path.to_string_lossy().into_owned(),
                    issues: issues_from_error(&error),
                });
                return Ok(());
            }
        };
        let transaction = database.transaction().map_err(|source| {
            error(CognitionCode::MemoryBoxIndexWriteFailed).with_source(source)
        })?;
        let committed = insert_manifest(&transaction, &manifest, &manifest_path).and_then(|()| {
            transaction.commit().map_err(|source| {
                error(CognitionCode::MemoryBoxIndexInsertFailed).with_source(source)
            })
        });
        match committed {
            Ok(()) => self.indexed_count += 1,
            Err(error) => self.skipped.push(BoxIndexSkip {
                path: manifest_path.to_string_lossy().into_owned(),
                issues: vec![error.code().into()],
            }),
        }
        Ok(())
    }
}

/// Opens the index read-only, rebuilding it first when it is missing; the
/// index must resolve inside the box root.
fn open_index(root: &Path) -> CognitionResult<Connection> {
    let path = root.join("index.sqlite");
    if !path
        .try_exists()
        .map_err(|source| error(CognitionCode::MemoryBoxIndexReadFailed).with_source(source))?
    {
        rebuild_index(root)?;
    }
    let canonical_root = fs::canonicalize(root)
        .map_err(|source| error(CognitionCode::MemoryBoxIndexReadFailed).with_source(source))?;
    let canonical_index = fs::canonicalize(&path)
        .map_err(|source| error(CognitionCode::MemoryBoxIndexReadFailed).with_source(source))?;
    if !canonical_index.starts_with(&canonical_root) {
        return Err(error(CognitionCode::MemoryBoxIndexPathUnsafe));
    }
    Connection::open_with_flags(&canonical_index, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|source| error(CognitionCode::MemoryBoxIndexReadFailed).with_source(source))
}

pub(super) fn count_indexed(root: &Path) -> CognitionResult<usize> {
    let database = open_index(root)?;
    database
        .query_row("SELECT COUNT(*) FROM box_items", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|source| error(CognitionCode::MemoryBoxIndexInvalid).with_source(source))
        .and_then(|count| {
            usize::try_from(count)
                .map_err(|source| error(CognitionCode::MemoryBoxIndexInvalid).with_source(source))
        })
}

/// One `box_items` row, as `box list` shows it.
#[derive(Serialize)]
struct IndexedItem {
    box_item_id: String,
    schema_version: String,
    kind: String,
    status: String,
    title: Option<String>,
    summary: Option<String>,
    privacy_class: String,
    retention_class: String,
    freshness_class: String,
    created_at: String,
    captured_at: Option<String>,
    updated_at: String,
    manifest_path: String,
    content_hash: Option<String>,
}

/// The newest `limit` index rows.
pub(super) fn list_indexed(root: &Path, limit: usize) -> CognitionResult<Vec<Value>> {
    let database = open_index(root)?;
    let invalid =
        |source: rusqlite::Error| error(CognitionCode::MemoryBoxIndexInvalid).with_source(source);
    let mut statement = database
        .prepare(
            "SELECT box_item_id,schema_version,kind,status,title,summary,privacy_class,\
             retention_class,freshness_class,created_at,captured_at,updated_at,manifest_path,content_hash \
             FROM box_items ORDER BY created_at DESC,box_item_id DESC LIMIT ?1",
        )
        .map_err(invalid)?;
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let rows = statement
        .query_map(params![limit], |row| {
            Ok(IndexedItem {
                box_item_id: row.get(0)?,
                schema_version: row.get(1)?,
                kind: row.get(2)?,
                status: row.get(3)?,
                title: row.get(4)?,
                summary: row.get(5)?,
                privacy_class: row.get(6)?,
                retention_class: row.get(7)?,
                freshness_class: row.get(8)?,
                created_at: row.get(9)?,
                captured_at: row.get(10)?,
                updated_at: row.get(11)?,
                manifest_path: row.get(12)?,
                content_hash: row.get(13)?,
            })
        })
        .map_err(invalid)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(invalid)?;
    rows.iter()
        .map(|row| {
            serde_json::to_value(row)
                .map_err(|source| error(CognitionCode::MemoryBoxIndexInvalid).with_source(source))
        })
        .collect()
}

fn create_schema(database: &Connection) -> CognitionResult<()> {
    database
        .execute_batch(
            "PRAGMA journal_mode = DELETE;
             PRAGMA foreign_keys = ON;
             CREATE TABLE box_items (
               box_item_id TEXT PRIMARY KEY, schema_version TEXT NOT NULL, kind TEXT NOT NULL,
               status TEXT NOT NULL, title TEXT, summary TEXT, privacy_class TEXT NOT NULL,
               retention_class TEXT NOT NULL, freshness_class TEXT NOT NULL, created_at TEXT NOT NULL,
               captured_at TEXT, updated_at TEXT NOT NULL, manifest_path TEXT NOT NULL, content_hash TEXT
             );
             CREATE TABLE box_item_files (
               id INTEGER PRIMARY KEY AUTOINCREMENT, box_item_id TEXT NOT NULL REFERENCES box_items(box_item_id),
               role TEXT NOT NULL, path TEXT, box_relative_path TEXT, ownership TEXT NOT NULL,
               size_bytes INTEGER, sha256 TEXT, mime_type TEXT, mtime TEXT
             );
             CREATE TABLE box_item_origins (
               box_item_id TEXT NOT NULL REFERENCES box_items(box_item_id), ref_type TEXT NOT NULL,
               ref_id TEXT NOT NULL, PRIMARY KEY (box_item_id, ref_type, ref_id)
             );
             CREATE TABLE box_item_refs (
               box_item_id TEXT NOT NULL REFERENCES box_items(box_item_id), ref_type TEXT NOT NULL,
               ref_id TEXT NOT NULL, relation TEXT NOT NULL,
               PRIMARY KEY (box_item_id, ref_type, ref_id, relation)
             );
             CREATE TABLE box_item_tags (
               box_item_id TEXT NOT NULL REFERENCES box_items(box_item_id), tag TEXT NOT NULL,
               PRIMARY KEY (box_item_id, tag)
             );
             CREATE INDEX idx_box_items_kind ON box_items(kind);
             CREATE INDEX idx_box_items_status ON box_items(status);
             CREATE INDEX idx_box_items_created_at ON box_items(created_at);
             CREATE INDEX idx_box_items_privacy ON box_items(privacy_class);
             CREATE INDEX idx_box_item_origins_ref ON box_item_origins(ref_type, ref_id);
             CREATE INDEX idx_box_item_refs_ref ON box_item_refs(ref_type, ref_id);
             CREATE INDEX idx_box_item_tags_tag ON box_item_tags(tag);",
        )
        .map_err(|source| error(CognitionCode::MemoryBoxIndexWriteFailed).with_source(source))
}

fn insert_manifest(
    database: &Transaction<'_>,
    manifest: &BoxManifest,
    manifest_path: &Path,
) -> CognitionResult<()> {
    insert_item(database, manifest, manifest_path)?;
    for file in &manifest.files {
        execute(
            database,
            "INSERT INTO box_item_files (box_item_id, role, path, box_relative_path, ownership, size_bytes, sha256, mime_type, mtime) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                manifest.box_item_id,
                file.role,
                file.path,
                file.box_relative_path,
                file.ownership.as_str(),
                file.size_bytes,
                file.sha256,
                file.mime_type,
                file.mtime,
            ],
        )?;
    }
    let origin = &manifest.origin;
    let origins = [
        ("session_id", origin.session_id.as_deref()),
        ("turn_id", origin.turn_id.as_deref()),
        ("message_id", origin.message_id.as_deref()),
        ("tool_call_id", origin.tool_call_id.as_deref()),
        ("worker_run_id", origin.worker_run_id.as_deref()),
        (
            "consolidation_run_id",
            origin.consolidation_run_id.as_deref(),
        ),
    ];
    for (kind, id) in origins
        .into_iter()
        .filter_map(|(kind, id)| id.map(|id| (kind, id)))
    {
        execute(
            database,
            "INSERT OR IGNORE INTO box_item_origins VALUES (?1, ?2, ?3)",
            params![manifest.box_item_id, kind, id],
        )?;
    }
    insert_refs(database, manifest)?;
    for tag in &manifest.tags {
        execute(
            database,
            "INSERT OR IGNORE INTO box_item_tags VALUES (?1, ?2)",
            params![manifest.box_item_id, tag],
        )?;
    }
    Ok(())
}

fn insert_item(
    database: &Transaction<'_>,
    manifest: &BoxManifest,
    manifest_path: &Path,
) -> CognitionResult<()> {
    let content_hash = manifest
        .files
        .iter()
        .find(|file| file.role == "primary")
        .and_then(|file| file.sha256.as_deref());
    execute(
        database,
        "INSERT INTO box_items VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            manifest.box_item_id,
            manifest.schema,
            manifest.kind.as_str(),
            manifest.status.as_str(),
            manifest.title,
            manifest.summary,
            manifest.privacy.class_name.as_str(),
            manifest.retention.class_name.as_str(),
            manifest.freshness.class_name.as_str(),
            manifest.created_at,
            manifest.captured_at,
            manifest.updated_at,
            manifest_path.to_string_lossy(),
            content_hash,
        ],
    )
}

fn insert_refs(database: &Transaction<'_>, manifest: &BoxManifest) -> CognitionResult<()> {
    for (kind, ids, relation) in [
        ("memory_chunk", &manifest.refs.memory_chunk_ids, "evidence"),
        ("feedback", &manifest.refs.feedback_ids, "feedback_context"),
        ("knowhow", &manifest.refs.knowhow_ids, "training_evidence"),
        (
            "graph_edge",
            &manifest.refs.graph_edge_ids,
            "graph_evidence",
        ),
    ] {
        for id in ids {
            insert_ref(database, &manifest.box_item_id, kind, id, relation)?;
        }
    }
    if let Some(id) = &manifest.refs.parent_box_item_id {
        insert_ref(database, &manifest.box_item_id, "box_item", id, "parent")?;
    }
    Ok(())
}

fn execute(
    database: &Transaction<'_>,
    sql: &str,
    params: impl rusqlite::Params,
) -> CognitionResult<()> {
    database
        .execute(sql, params)
        .map_err(|source| error(CognitionCode::MemoryBoxIndexInsertFailed).with_source(source))?;
    Ok(())
}

fn insert_ref(
    database: &Transaction<'_>,
    item_id: &str,
    kind: &str,
    ref_id: &str,
    relation: &str,
) -> CognitionResult<()> {
    database
        .execute(
            "INSERT OR IGNORE INTO box_item_refs VALUES (?1, ?2, ?3, ?4)",
            params![item_id, kind, ref_id, relation],
        )
        .map_err(|source| error(CognitionCode::MemoryBoxIndexInsertFailed).with_source(source))?;
    Ok(())
}

fn issues_from_error(error: &CognitionError) -> Vec<String> {
    if error.code() == "memory_box_manifest_invalid"
        && error.message() != "Cognition Box operation failed"
    {
        error.message().split("; ").map(str::to_owned).collect()
    } else {
        vec![error.code().into()]
    }
}
