//! Scoped pre-images, never database copies. All I/O runs on a blocking worker.
//!
//! Boundary: native schema migration/owner registration precedes inventory.
//! This restores pre-observation legacy state, not pre-upgrade database bytes.
//!
//! Downgrade restore (offline): verify manifest/hash, disable projection/feed
//! triggers while restoring each preimages row by its key; NULL row_json means
//! delete that key. Restore the captured wm_migration and sqlite_sequence feed
//! entry, then restore the two turn trigger DDLs. Drop the listed build-created
//! legacy indexes and the new wm_* schema. Untouched legacy tables supply the
//! remaining pre-cutover state. Restore feed rows by session_id, including their
//! original seq; the recorded max(seq) is information, NEVER a deletion rule.
//!
//! Write enumeration v1 (paths relative to crates/):
//! - butler-turn/src/btcc/storage/project_work_runtime/result.rs:111,166,182,221:
//!   upsert btcc_guided_works(work_id), btcc_guided_turn_work_bindings
//!   (binding_revision_id), btcc_guided_work_results(result_ref), and
//!   btcc_guided_work_session_heads(session_id). No history deletes/import port.
//! - butler-turn/src/btcc/storage/schema/task_graphs.rs:16,20,24: binding INSERT
//!   (current only), work INSERT/UPDATE fire task_graph_binding_insert,
//!   task_graph_work_insert, task_graph_work_update. They insert/update
//!   agent_task_graph_changes(session_id), advancing sqlite_sequence(name).
//!   UPDATE also selects current binding sessions; ownership validation at
//!   project_work_runtime/result/ownership.rs:182 requires those same observed
//!   Work/session bindings before any write. Thus inventory sessions cover them.
//!   No triggers on result/session-head tables. Other six feed triggers do
//!   not fire: cutover never writes plans/checkpoints/delegations/results/turns.
//! - butler-work/src/cutover/batches.rs:22,119,259,265,296: wm_migration state,
//!   cursor/counts/needs_source/epoch/watermark, DROP two task_graph_turn triggers.
//! - butler-work/src/cutover/import.rs:27,126,192; target.rs:11,165,229;
//!   version.rs:17; store/entities.rs:98, specs.rs:49,76,123,
//!   store.rs:131 and store/counts.rs:5: wm_works, wm_tasks,
//!   wm_task_chains, wm_task_edges, wm_task_parts, wm_task_part_edges,
//!   wm_spec_nodes, wm_spec_bodies, wm_spec_revisions, wm_spec_criteria,
//!   wm_counts, wm_audit, wm_outbox, wm_legacy_map, wm_instructions. Their only
//!   triggers are immutable-history rejection guards (work_schema/support.sql:48)
//!   and have no target writes; sqlite_sequence advances for audit/outbox.
//! - butler-turn/src/btcc/storage/work_model_cutover.rs:45: low-space status
//!   lives only in process memory; postponement writes no cutover data.
//! - inventory.rs:47: wm_cutover_inventory replaces one durable inventory row.
//! - butler-turn/src/btcc/storage/migration.rs:76; work_schema.rs:25: additive wm_* schema and
//!   wm_legacy_session_work/wm_pending_directions indexes before this backup.
//! - butler-agent/src/host/runtime/work_cutover.rs:275: App DB read-only.
use super::{
    backup_files::*,
    inventory::Inventory,
    scoped_backup,
    state::{self, CutoverState},
};
use butler_platform::{fs_space, secure_fs, sqlite};
use rusqlite::OpenFlags;
use serde::{Deserialize, Serialize};
use std::{fs, io, path::Path};

const BTCC: &str = "agent-runtime/btcc.sqlite";
pub(super) const ENUMERATION_VERSION: u32 = 1;
#[derive(Debug, Serialize, Deserialize)]
pub struct BackupFile {
    pub name: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct TableBackup {
    pub keys: u64,
    pub rows: u64,
    pub absent: u64,
    pub bytes: u64,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub files: Vec<BackupFile>,
    pub tables: std::collections::BTreeMap<String, TableBackup>,
    pub read_only_tables: Vec<String>,
    pub schema_version: i64,
    pub inventory_hash: String,
    pub enumeration_version: u32,
}

pub fn check_epoch(root: &Path) -> io::Result<()> {
    if root.join(BTCC).exists() {
        let db = open(root, true)?;
        state::check_epoch(&db).map_err(error)?;
    }
    Ok(())
}
fn open(root: &Path, readonly: bool) -> io::Result<sqlite::Connection> {
    reject_links(root, Path::new(BTCC))?;
    sqlite::open_with_flags(
        root.join(BTCC),
        if readonly {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        } else {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        },
    )
    .map_err(error)
}

/// Reuse persisted inputs only when their exact completed pre-image is valid.
/// With no completed set, callers recompute Ledger observations before prepare.
pub fn frozen_inventory(root: &Path) -> io::Result<Option<Inventory>> {
    let db = open(root, true)?;
    let Some(inventory) = Inventory::load(&db).map_err(error)? else {
        return Ok(None);
    };
    let folder = root.join("backups/work-model-cutover");
    if !folder.exists() {
        return Ok(None);
    }
    reject_links(root, Path::new("backups/work-model-cutover"))?;
    for path in completed(&folder)? {
        if matches_inventory(&path, &inventory, &|| false)? {
            return Ok(Some(inventory));
        }
    }
    Ok(None)
}

pub fn prepare(root: &Path, inventory: &Inventory) -> io::Result<CutoverState> {
    prepare_with_cancel(root, inventory, &|| false)
}

/// Precheck precedes inventory/state/filesystem writes. Schema installation is
/// native startup's responsibility; this estimates only cutover writes.
pub fn prepare_with_cancel(
    root: &Path,
    inventory: &Inventory,
    cancelled: &dyn Fn() -> bool,
) -> io::Result<CutoverState> {
    check_cancelled(cancelled)?;
    let db = open(root, true)?;
    state::check_epoch(&db).map_err(error)?;
    if state::status(&db).map_err(error)?.state == CutoverState::Done {
        return Ok(CutoverState::Done);
    }
    let needed = scoped_backup::estimate(&db, inventory).map_err(error)?;
    if !scoped_backup::has_space(fs_space::available_bytes(root)?, needed) {
        return Ok(CutoverState::PostponedNoSpace);
    }
    let persisted = Inventory::load(&db).map_err(error)?;
    let same = persisted
        .as_ref()
        .map(Inventory::hash)
        .transpose()
        .map_err(error)?
        == Some(inventory.hash().map_err(error)?);
    let folder = root.join("backups/work-model-cutover");
    if same && folder.exists() {
        reject_links(root, Path::new("backups/work-model-cutover"))?;
        for path in completed(&folder)?.iter().rev() {
            if matches_inventory(path, inventory, cancelled)? {
                retain(&folder, path)?;
                return Ok(CutoverState::Importing);
            }
        }
    }
    drop(db);
    let writer = open(root, false)?;
    writer
        .pragma_update(None, "synchronous", "FULL")
        .map_err(error)?;
    inventory.save(&writer).map_err(error)?;
    drop(writer);
    let folder = private_folder(root, "backups/work-model-cutover")?;
    remove_partial_sets(&folder)?;
    let destination = folder.join(chrono::Utc::now().format("%Y%m%dT%H%M%S%.9fZ").to_string());
    secure_fs::create_private_dir(&destination)?;
    secure_fs::protect_folder(&destination).unwrap_or(Ok(()))?;
    let side = destination.join("pre-cutover.sqlite");
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    secure_fs::owner_only(&mut options);
    drop(options.open(&side)?);
    let db = open(root, true)?;
    let mut manifest = scoped_backup::export(&db, &side, inventory, cancelled).map_err(error)?;
    secure_fs::sync_path(&side)?;
    manifest.files.push(BackupFile {
        name: "pre-cutover.sqlite".into(),
        size: fs::metadata(&side)?.len(),
        sha256: hash(&side, cancelled)?,
    });
    publish(&destination, &manifest)?;
    retain(&folder, &destination)?;
    Ok(CutoverState::Importing)
}

fn matches_inventory(
    path: &Path,
    inventory: &Inventory,
    cancelled: &dyn Fn() -> bool,
) -> io::Result<bool> {
    if !valid_with_cancel(path, cancelled).unwrap_or(false) {
        return Ok(false);
    }
    Ok(read_manifest(path)?.inventory_hash == inventory.hash().map_err(error)?)
}
fn read_manifest(path: &Path) -> io::Result<Manifest> {
    serde_json::from_reader(secure_fs::open_read_no_follow(&path.join("manifest.json"))?)
        .map_err(error)
}
pub fn valid(path: &Path) -> io::Result<bool> {
    valid_with_cancel(path, &|| false)
}
fn valid_with_cancel(path: &Path, cancelled: &dyn Fn() -> bool) -> io::Result<bool> {
    let manifest = read_manifest(path)?;
    if manifest.enumeration_version != ENUMERATION_VERSION || manifest.files.len() != 1 {
        return Ok(false);
    }
    let file = &manifest.files[0];
    if file.name != "pre-cutover.sqlite" {
        return Ok(false);
    }
    let target = path.join(&file.name);
    Ok(fs::metadata(&target)?.len() == file.size && hash(&target, cancelled)? == file.sha256)
}
