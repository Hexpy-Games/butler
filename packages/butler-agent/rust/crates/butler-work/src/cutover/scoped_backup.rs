//! One snapshot covers projection pre-images, trigger targets, and restore DDL.
use super::{
    backup::{ENUMERATION_VERSION, Manifest, TableBackup},
    backup_files::check_cancelled,
    inventory::Inventory,
    source::row_json,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::{collections::BTreeMap, path::Path};

pub(super) const TABLE_KEYS: &[(&str, &str)] = &[
    ("btcc_guided_works", "work_id"),
    ("btcc_guided_turn_work_bindings", "binding_revision_id"),
    ("btcc_guided_work_results", "result_ref"),
    ("btcc_guided_work_session_heads", "session_id"),
    ("agent_task_graph_changes", "session_id"),
];

pub fn has_space(available: u64, needed: u64) -> bool {
    available >= needed
}

pub(super) fn estimate(db: &Connection, inventory: &Inventory) -> rusqlite::Result<u64> {
    // Startup-only indexed counts and payload totals, not database size. Include
    // all history: a single latest plan can contain arbitrarily many tasks.
    let mut needed = serde_json::to_vec(inventory)
        .map_err(|_| rusqlite::Error::InvalidQuery)?
        .len() as u64
        * 4;
    for (table, key) in TABLE_KEYS {
        for id in inventory.keys.get(*table).into_iter().flatten() {
            let row = preimage(db, table, key, id)?;
            needed = needed.saturating_add(row.map_or(4096, |r| r.len() as u64 + 4096));
        }
    }
    for (table, index) in [
        ("btcc_guided_works", "sqlite_autoindex_btcc_guided_works_1"),
        (
            "btcc_guided_work_plan_revisions",
            "sqlite_autoindex_btcc_guided_work_plan_revisions_2",
        ),
        ("btcc_subsession_directions", "wm_pending_directions"),
    ] {
        let count: u64 = db.query_row(
            &format!(
                "SELECT count(*) FROM {table} INDEXED BY {index}{}",
                if table == "btcc_subsession_directions" {
                    " WHERE status='pending'"
                } else {
                    ""
                }
            ),
            [],
            |r| r.get(0),
        )?;
        needed = needed.saturating_add(count.saturating_mul(65536));
    }
    let payload: u64 = db.query_row(
        "SELECT (SELECT coalesce(sum(length(CAST(actions_json AS BLOB))),0) FROM btcc_guided_work_plan_revisions) + (SELECT coalesce(sum(length(CAST(objective AS BLOB))),0) FROM btcc_guided_works) + (SELECT coalesce(sum(length(CAST(instruction AS BLOB))),0) FROM btcc_subsession_directions INDEXED BY wm_pending_directions WHERE status='pending')",
        [],
        |r| r.get(0),
    )?;
    // 128x source bytes covers task/part rows, edges, indexes, audit and WAL;
    // fixed reserve covers schema/page rounding and small metadata transactions.
    Ok(needed
        .saturating_add(payload.saturating_mul(128))
        .saturating_mul(2)
        .saturating_add(16 * 1024 * 1024))
}

fn preimage(
    db: &Connection,
    table: &str,
    column: &str,
    id: &str,
) -> rusqlite::Result<Option<String>> {
    db.query_row(
        &format!("SELECT * FROM {table} WHERE {column}=?1"),
        [id],
        exact_row,
    )
    .optional()?
    .map(|row| serde_json::to_string(&row).map_err(|_| rusqlite::Error::InvalidQuery))
    .transpose()
}

// Backup must refuse unrepresentable values rather than change their bytes.
fn exact_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<serde_json::Value> {
    for i in 0..row.as_ref().column_count() {
        match row.get_ref(i)? {
            rusqlite::types::ValueRef::Text(bytes) => {
                std::str::from_utf8(bytes).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        i,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
            }
            rusqlite::types::ValueRef::Real(value) if !value.is_finite() => {
                return Err(rusqlite::Error::InvalidQuery);
            }
            _ => {}
        }
    }
    row_json(row)
}

pub(super) fn export(
    db: &Connection,
    path: &Path,
    inventory: &Inventory,
    cancelled: &dyn Fn() -> bool,
) -> rusqlite::Result<Manifest> {
    db.execute_batch("BEGIN")?;
    // First read pins the snapshot before opening or writing the side file.
    let watermark: i64 = db.query_row(
        "SELECT coalesce(max(seq),0) FROM agent_task_graph_changes",
        [],
        |r| r.get(0),
    )?;
    let target = butler_platform::sqlite::open(path)?;
    target.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN; CREATE TABLE preimages(table_name TEXT NOT NULL,key TEXT NOT NULL,row_json TEXT,PRIMARY KEY(table_name,key)); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);")?;
    let tables = capture_all(db, &target, inventory, cancelled)?;
    metadata(
        &target,
        "inventory",
        &serde_json::to_string(inventory).map_err(|_| rusqlite::Error::InvalidQuery)?,
    )?;
    metadata(&target, "feed_watermark", &watermark.to_string())?;
    schema_metadata(db, &target)?;
    let read_only_tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'btcc_*' ORDER BY name")?
        .query_map([], |r| r.get::<_, String>(0))?.filter_map(|r| match r {
            Ok(name) if TABLE_KEYS.iter().any(|(t, _)| *t == name) => None,
            other => Some(other),
        }).collect::<rusqlite::Result<Vec<_>>>()?;
    let schema_version = db.pragma_query_value(None, "schema_version", |r| r.get(0))?;
    target.execute_batch("COMMIT")?;
    db.execute_batch("COMMIT")?;
    Ok(Manifest {
        files: vec![],
        tables,
        read_only_tables,
        schema_version,
        inventory_hash: inventory
            .hash()
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        enumeration_version: ENUMERATION_VERSION,
    })
}
fn capture_all(
    db: &Connection,
    target: &Connection,
    inventory: &Inventory,
    cancelled: &dyn Fn() -> bool,
) -> rusqlite::Result<BTreeMap<String, TableBackup>> {
    let mut tables = BTreeMap::new();
    for (table, column) in TABLE_KEYS {
        for id in inventory.keys.get(*table).into_iter().flatten() {
            check_cancelled(cancelled).map_err(|_| rusqlite::Error::InvalidQuery)?;
            capture(db, target, table, column, id)?;
        }
    }
    capture(db, target, "wm_migration", "singleton", "1")?;
    capture(
        db,
        target,
        "sqlite_sequence",
        "name",
        "agent_task_graph_changes",
    )?;
    for table in TABLE_KEYS
        .iter()
        .map(|(t, _)| *t)
        .chain(["wm_migration", "sqlite_sequence"])
    {
        let summary = target.query_row("SELECT count(*),count(row_json),coalesce(sum(length(CAST(row_json AS BLOB))),0) FROM preimages WHERE table_name=?1", [table], |r| {
            let keys: u64 = r.get(0)?;
            let rows: u64 = r.get(1)?;
            Ok(TableBackup { keys, rows, absent: keys - rows, bytes: r.get(2)? })
        })?;
        tables.insert(table.to_owned(), summary);
    }
    Ok(tables)
}
fn capture(
    db: &Connection,
    target: &Connection,
    table: &str,
    column: &str,
    id: &str,
) -> rusqlite::Result<()> {
    target.execute(
        "INSERT INTO preimages VALUES(?1,?2,?3)",
        params![table, id, preimage(db, table, column, id)?],
    )?;
    Ok(())
}
fn metadata(target: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    target.execute("INSERT INTO metadata VALUES(?1,?2)", [key, value])?;
    Ok(())
}
fn schema_metadata(db: &Connection, target: &Connection) -> rusqlite::Result<()> {
    for name in ["task_graph_turn_insert", "task_graph_turn_update"] {
        let ddl: Option<String> = db
            .query_row(
                "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?1",
                [name],
                |r| r.get(0),
            )
            .optional()?;
        metadata(
            target,
            name,
            &serde_json::to_string(&ddl).map_err(|_| rusqlite::Error::InvalidQuery)?,
        )?;
    }
    metadata(
        target,
        "legacy_indexes",
        "[\"wm_legacy_session_work\",\"wm_pending_directions\"]",
    )
}
