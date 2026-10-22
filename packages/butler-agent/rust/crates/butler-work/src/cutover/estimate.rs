//! One indexed inventory walk per attempt; postponed starts use the durable cache.
use super::{inventory::Inventory, scoped_backup, shape};
use crate::store::{self, Result, Transaction};
use rusqlite::{Connection, OptionalExtension, params};

pub(super) const BATCH_ROWS: u64 = 500;
pub(super) const BATCH_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Default)]
pub struct EstimateCounts {
    pub works: u64,
    pub tasks: u64,
    pub parts: u64,
    pub chains: u64,
    pub task_edges: u64,
    pub part_edges: u64,
    pub bodies: u64,
    pub compressed_bytes: u64,
}
impl EstimateCounts {
    /// Measured record coefficients, page packing, one bounded WAL batch and
    /// 256 KiB for metadata/page rounding. Side-file bytes are already packed.
    pub fn needed(&self, side_bytes: u64) -> u64 {
        let records = [
            (self.works, 1450),
            (self.tasks, 1000),
            (self.parts, 500),
            (self.chains, 450),
            (self.task_edges, 900),
            (self.part_edges, 600),
            (self.bodies, 140),
        ]
        .into_iter()
        .fold(self.compressed_bytes, |sum, (n, bytes)| {
            sum.saturating_add(n.saturating_mul(bytes))
        });
        let packed = records.saturating_mul(10).saturating_add(6) / 7;
        packed
            .saturating_add(side_bytes)
            .saturating_add(packed.min(BATCH_BYTES * 2))
            .saturating_add(128 * 4096)
            .saturating_add(256 * 1024)
    }
}

pub fn cached_estimate(db: &Connection, inventory: &Inventory) -> Result<Option<u64>> {
    let hash = inventory.hash()?;
    Ok(db.query_row("SELECT json_extract(source_counts_json,'$.backup_estimate.bytes') FROM wm_migration WHERE singleton=1 AND json_extract(source_counts_json,'$.backup_estimate.hash')=?1", [hash], |r| r.get(0)).optional()?.flatten())
}

/// Caller owns BTCC's writer transaction. Cache metadata is the only write
/// allowed before the disk-space decision; source and target content stay put.
pub fn freeze_inventory(tx: &Transaction<'_>, inventory: &Inventory) -> Result<u64> {
    super::state::check_epoch(tx)?;
    if let Some(needed) = cached_estimate(tx, inventory)? {
        return Ok(needed);
    }
    let needed = estimate(tx, inventory)?;
    super::batches::begin(tx, super::state::CutoverState::Pending)?;
    inventory.save(tx)?;
    tx.execute("UPDATE wm_migration SET source_counts_json=json_set(source_counts_json,'$.backup_estimate',json_object('hash',?1,'bytes',?2)) WHERE singleton=1", params![inventory.hash()?, needed])?;
    Ok(needed)
}

fn estimate(db: &Connection, inventory: &Inventory) -> Result<u64> {
    let mut counts = EstimateCounts::default();
    let mut ids = inventory
        .keys
        .get("btcc_guided_works")
        .cloned()
        .unwrap_or_default();
    ids.extend(
        db.prepare(
            "SELECT work_id FROM btcc_guided_works INDEXED BY sqlite_autoindex_btcc_guided_works_1",
        )?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?,
    );
    counts.works = ids.len() as u64;
    for id in ids {
        let objective: Option<String> = db
            .query_row(
                "SELECT objective FROM btcc_guided_works WHERE work_id=?1",
                [&id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(body) = objective {
            counts.bodies += 1;
            counts.compressed_bytes += zstd::stream::encode_all(body.as_bytes(), 3)
                .map_err(store::Error::BodyCodec)?
                .len() as u64;
        }
        let actions: Option<String> = db.query_row("SELECT actions_json FROM btcc_guided_work_plan_revisions WHERE work_id=?1 ORDER BY revision DESC LIMIT 1", [&id], |r| r.get(0)).optional()?;
        let Some(actions) = actions else { continue };
        // Invalid sources are retained as needs_source, never materialized.
        let Ok(actions) = serde_json::from_str::<Vec<shape::Action>>(&actions) else {
            continue;
        };
        let Ok(layout) = shape::layout(&actions) else {
            continue;
        };
        if let Some(chains) = layout.chains {
            counts.tasks += actions.len() as u64;
            counts.chains += chains.len() as u64;
            counts.task_edges += layout.edges.len() as u64;
        } else {
            counts.tasks += 1;
            counts.chains += 1;
            counts.parts += actions.len() as u64;
            counts.part_edges += layout.edges.len() as u64;
        }
    }
    let (directions, bytes): (u64, u64) = db.query_row("SELECT count(*),coalesce(sum(length(CAST(instruction AS BLOB))),0) FROM btcc_subsession_directions INDEXED BY wm_pending_directions WHERE status='pending'", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
    counts.bodies += directions;
    // Source bytes bound compressed direction bodies, including codec framing.
    counts.compressed_bytes += bytes + directions * 64;
    let side = scoped_backup::side_estimate(db, inventory)?;
    Ok(counts.needed(side))
}
