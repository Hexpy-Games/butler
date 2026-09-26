use std::{fs, path::Path};

use rusqlite::{Connection, Transaction, params};
use serde::Serialize;
use serde_json::{Value, json};

use crate::cognition::{CognitionError, CognitionResult};

use super::{error, index_io, manifest, paths};
use manifest::BoxManifest;

const INDEX_REPORT_SCHEMA: &str = "butler.cognition.box.index-rebuild-report.v1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct BoxIndexReport {
    pub schema: &'static str,
    pub rebuilt_at: String,
    pub status: &'static str,
    pub indexed_count: usize,
    pub skipped_count: usize,
    pub skipped: Vec<BoxIndexSkip>,
    pub index_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct BoxIndexSkip {
    pub path: String,
    pub issues: Vec<String>,
}

pub(super) fn rebuild_index(root: &Path) -> CognitionResult<BoxIndexReport> {
    index_io::create_private_dir(root)?;
    let index_path = root.join("index.sqlite");
    let report_path = root.join("index-rebuild-report.json");
    let temporary = root.join(format!("index.sqlite.tmp-{}", uuid::Uuid::new_v4()));
    let mut skipped = Vec::new();
    let mut indexed_count = 0;

    let result = (|| {
        index_io::create_private_file(&temporary)?;
        let mut database =
            Connection::open(&temporary).map_err(|_| error("memory_box_index_write_failed"))?;
        create_schema(&database)?;

        if paths::canonical_items_root(root)?.is_some() {
            let entries = fs::read_dir(root.join("items"))
                .map_err(|_| error("memory_box_items_read_failed"))?;
            for entry in entries {
                let entry = entry.map_err(|_| error("memory_box_items_read_failed"))?;
                if !entry
                    .file_type()
                    .map_err(|_| error("memory_box_items_read_failed"))?
                    .is_dir()
                {
                    continue;
                }
                let item_dir = entry.path();
                let manifest_path = item_dir.join("manifest.json");
                let expected_id = entry.file_name().to_string_lossy().into_owned();
                let manifest = match manifest::read_manifest_for_dir(root, &item_dir, &expected_id)
                {
                    Ok(Some(manifest)) => manifest,
                    Ok(None) => continue,
                    Err(error) => {
                        skipped.push(BoxIndexSkip {
                            path: manifest_path.to_string_lossy().into_owned(),
                            issues: issues_from_error(&error),
                        });
                        continue;
                    }
                };

                let transaction = database
                    .transaction()
                    .map_err(|_| error("memory_box_index_write_failed"))?;
                let inserted = insert_manifest(&transaction, &manifest, &manifest_path);
                let committed = inserted.and_then(|()| {
                    transaction
                        .commit()
                        .map_err(|_| error("memory_box_index_insert_failed"))
                });
                if let Err(error) = committed {
                    skipped.push(BoxIndexSkip {
                        path: manifest_path.to_string_lossy().into_owned(),
                        issues: vec![error.code.into()],
                    });
                } else {
                    indexed_count += 1;
                }
            }
        }

        database
            .close()
            .map_err(|_| error("memory_box_index_write_failed"))?;
        fs::rename(&temporary, &index_path).map_err(|_| error("memory_box_index_write_failed"))?;
        let report = BoxIndexReport {
            schema: INDEX_REPORT_SCHEMA,
            rebuilt_at: index_io::now_iso(),
            status: if skipped.is_empty() { "ok" } else { "partial" },
            indexed_count,
            skipped_count: skipped.len(),
            skipped,
            index_path: index_path.to_string_lossy().into_owned(),
        };
        index_io::write_report(&report_path, &report)?;
        Ok(report)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        if let Some(name) = temporary.file_name().and_then(|name| name.to_str()) {
            let journal = temporary.with_file_name(format!("{name}-journal"));
            let _ = fs::remove_file(journal);
        }
    }
    result
}

pub(super) fn count_indexed(root: &Path) -> CognitionResult<usize> {
    let path = root.join("index.sqlite");
    if !path
        .try_exists()
        .map_err(|_| error("memory_box_index_read_failed"))?
    {
        rebuild_index(root)?;
    }
    let canonical_root =
        fs::canonicalize(root).map_err(|_| error("memory_box_index_read_failed"))?;
    let canonical_index =
        fs::canonicalize(&path).map_err(|_| error("memory_box_index_read_failed"))?;
    if !canonical_index.starts_with(&canonical_root) {
        return Err(error("memory_box_index_path_unsafe"));
    }
    let database =
        Connection::open_with_flags(&canonical_index, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| error("memory_box_index_read_failed"))?;
    database
        .query_row("SELECT COUNT(*) FROM box_items", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|_| error("memory_box_index_invalid"))
        .and_then(|count| usize::try_from(count).map_err(|_| error("memory_box_index_invalid")))
}

pub(super) fn list_indexed(root: &Path, limit: usize) -> CognitionResult<Vec<Value>> {
    let path = root.join("index.sqlite");
    if !path
        .try_exists()
        .map_err(|_| error("memory_box_index_read_failed"))?
    {
        rebuild_index(root)?;
    }
    let canonical_root =
        fs::canonicalize(root).map_err(|_| error("memory_box_index_read_failed"))?;
    let canonical_index =
        fs::canonicalize(&path).map_err(|_| error("memory_box_index_read_failed"))?;
    if !canonical_index.starts_with(&canonical_root) {
        return Err(error("memory_box_index_path_unsafe"));
    }
    let database =
        Connection::open_with_flags(&canonical_index, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| error("memory_box_index_read_failed"))?;
    let mut statement = database
        .prepare(
            "SELECT box_item_id,schema_version,kind,status,title,summary,privacy_class,\
             retention_class,freshness_class,created_at,captured_at,updated_at,manifest_path,content_hash \
             FROM box_items ORDER BY created_at DESC,box_item_id DESC LIMIT ?1",
        )
        .map_err(|_| error("memory_box_index_invalid"))?;
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let rows = statement
        .query_map(params![limit], |row| {
            Ok(json!({
                "box_item_id": row.get::<_, String>(0)?,
                "schema_version": row.get::<_, String>(1)?,
                "kind": row.get::<_, String>(2)?,
                "status": row.get::<_, String>(3)?,
                "title": row.get::<_, Option<String>>(4)?,
                "summary": row.get::<_, Option<String>>(5)?,
                "privacy_class": row.get::<_, String>(6)?,
                "retention_class": row.get::<_, String>(7)?,
                "freshness_class": row.get::<_, String>(8)?,
                "created_at": row.get::<_, String>(9)?,
                "captured_at": row.get::<_, Option<String>>(10)?,
                "updated_at": row.get::<_, String>(11)?,
                "manifest_path": row.get::<_, String>(12)?,
                "content_hash": row.get::<_, Option<String>>(13)?,
            }))
        })
        .map_err(|_| error("memory_box_index_invalid"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| error("memory_box_index_invalid"))
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
        .map_err(|_| error("memory_box_index_write_failed"))
}

fn insert_manifest(
    database: &Transaction<'_>,
    manifest: &BoxManifest,
    manifest_path: &Path,
) -> CognitionResult<()> {
    let content_hash = manifest
        .files
        .iter()
        .find(|file| file.role == "primary")
        .and_then(|file| file.sha256.as_deref());
    database
        .execute(
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
        .map_err(|_| error("memory_box_index_insert_failed"))?;

    for file in &manifest.files {
        database
            .execute(
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
            )
            .map_err(|_| error("memory_box_index_insert_failed"))?;
    }
    let origins = [
        ("session_id", manifest.origin.session_id.as_deref()),
        ("turn_id", manifest.origin.turn_id.as_deref()),
        ("message_id", manifest.origin.message_id.as_deref()),
        ("tool_call_id", manifest.origin.tool_call_id.as_deref()),
        ("worker_run_id", manifest.origin.worker_run_id.as_deref()),
        (
            "consolidation_run_id",
            manifest.origin.consolidation_run_id.as_deref(),
        ),
    ];
    for (kind, id) in origins
        .into_iter()
        .filter_map(|(kind, id)| id.map(|id| (kind, id)))
    {
        database
            .execute(
                "INSERT OR IGNORE INTO box_item_origins VALUES (?1, ?2, ?3)",
                params![manifest.box_item_id, kind, id],
            )
            .map_err(|_| error("memory_box_index_insert_failed"))?;
    }
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
    for tag in &manifest.tags {
        database
            .execute(
                "INSERT OR IGNORE INTO box_item_tags VALUES (?1, ?2)",
                params![manifest.box_item_id, tag],
            )
            .map_err(|_| error("memory_box_index_insert_failed"))?;
    }
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
        .map_err(|_| error("memory_box_index_insert_failed"))?;
    Ok(())
}

fn issues_from_error(error: &CognitionError) -> Vec<String> {
    if error.code == "memory_box_manifest_invalid"
        && error.message != "Cognition Box operation failed"
    {
        error.message.split("; ").map(str::to_owned).collect()
    } else {
        vec![error.code.into()]
    }
}
