//! Indexed immutable-chain reconstruction, without cloning each cumulative base.
use super::super::{StorageError, StorageResult, common::json};
use super::{
    delta::{self, Delta},
    memo::{self, ContinuationMemo, Entry},
};
use rusqlite::{Connection, OptionalExtension};

pub(super) struct Row {
    pub acceptance_id: String,
    pub turn_id: String,
    pub checkpoint_id: String,
    pub checkpoint_revision: u64,
    pub state: i64,
    pub raw: String,
    pub delta: Option<String>,
}
impl Row {
    pub(super) fn load(db: &Connection, id: &str) -> StorageResult<Self> {
        db.query_row(
            "SELECT acceptance_id,turn_id,checkpoint_id,checkpoint_revision,payload_state,
            normalized_response_json,continuation_delta_json FROM btcc_model_round_acceptances
            WHERE acceptance_id=?1",
            [id],
            |r| {
                Ok(Self {
                    acceptance_id: r.get(0)?,
                    turn_id: r.get(1)?,
                    checkpoint_id: r.get(2)?,
                    checkpoint_revision: r.get(3)?,
                    state: r.get(4)?,
                    raw: r.get(5)?,
                    delta: r.get(6)?,
                })
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .ok_or_else(delta::invalid)
    }
    fn matches(&self, row: &Self) -> bool {
        self.turn_id == row.turn_id
            && self.checkpoint_id == row.checkpoint_id
            && self.checkpoint_revision == row.checkpoint_revision
    }
}

// Passthrough: provider items stay opaque, preserving exact serialized bytes.
pub(super) fn reconstruct(
    db: &Connection,
    target: Row,
    memo: &mut ContinuationMemo,
) -> StorageResult<Entry> {
    let mut current = Row::load(db, &target.acceptance_id)?;
    let mut pending: Vec<Delta> = Vec::new();
    let (items, cached, mut count, mut bytes, mut depth) = loop {
        if !target.matches(&current) || pending.len() >= 10_000 {
            return Err(delta::invalid());
        }
        if !matches!(current.state, 0 | 1) {
            return Err(delta::invalid());
        }
        if let Some(entry) = memo.get(&current.acceptance_id) {
            if !entry.matches(
                &target.turn_id,
                &target.checkpoint_id,
                target.checkpoint_revision,
            ) || entry.chain_len + pending.len() > 10_000
            {
                return Err(delta::invalid());
            }
            break (
                None,
                Some(entry.acceptance_id.clone()),
                entry.items.len(),
                entry.approx_bytes,
                entry.chain_len,
            );
        }
        if current.state == 0 {
            let items = full_items(&current)?;
            // JSON size plus Value/string/map allocation overhead, conservatively.
            let bytes = current.raw.len() * 3 + items.len() * 160;
            let count = items.len();
            break (Some(items), None, count, bytes, 1);
        }
        let delta = delta::parse(current.delta.as_deref())?;
        current = Row::load(db, &delta.base)?;
        pending.push(delta);
    };
    for delta in pending.iter().rev() {
        delta::validate(count, delta)?;
        count = delta.count;
        bytes = bytes.saturating_add(delta::literal_bytes(delta)?);
        depth += 1;
    }
    let (mut items, mut serialized) = match items {
        Some(items) => {
            let serialized = memo::item_strings(&items)?;
            (items, serialized)
        }
        None => {
            let entry = memo
                .take(&cached.ok_or_else(delta::invalid)?)
                .ok_or_else(delta::invalid)?;
            (entry.items, entry.serialized)
        }
    };
    for delta in pending.into_iter().rev() {
        memo::apply_serialized_validated(&mut serialized, &delta)?;
        items = delta::apply_validated(items, &delta);
    }
    Ok(Entry {
        turn_id: target.turn_id,
        checkpoint_id: target.checkpoint_id,
        checkpoint_revision: target.checkpoint_revision,
        acceptance_id: target.acceptance_id,
        items,
        serialized,
        approx_bytes: bytes,
        chain_len: depth,
    })
}

// Passthrough: decode a legacy base without changing provider key order.
fn full_items(row: &Row) -> StorageResult<Vec<serde_json::Value>> {
    let mut value = json(
        &row.raw,
        super::super::StorageCode::ModelAcceptanceDeltaInvalid,
    )?;
    value
        .get_mut("continuation")
        .and_then(serde_json::Value::as_object_mut)
        .and_then(|v| v.shift_remove("statelessInput"))
        .and_then(|v| match v {
            serde_json::Value::Array(items) => Some(items),
            _ => None,
        })
        .ok_or_else(delta::invalid)
}
