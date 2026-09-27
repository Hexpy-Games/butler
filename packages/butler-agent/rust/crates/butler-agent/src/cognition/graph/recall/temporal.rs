//! Source-binned temporal seeds for conversation and event windows.

mod conversation;
mod event;
#[cfg(test)]
mod tests;

use std::collections::HashSet;

use rusqlite::Connection;

use crate::cognition::{
    CognitionResult,
    recall::{RecallRequest, RecallTimeBasis},
};

#[derive(Debug, Default)]
pub(in crate::cognition) struct TemporalSelection {
    pub seeds: Vec<String>,
    pub episode_ids: Vec<String>,
}

pub(super) fn select(
    db: &Connection,
    input: &RecallRequest,
    parse_date: impl Fn(&str) -> f64,
) -> CognitionResult<TemporalSelection> {
    let Some(time) = &input.time else {
        return Ok(TemporalSelection::default());
    };
    let from_ms = parse_date(&time.from);
    let to_ms = parse_date(&time.to);
    if !from_ms.is_finite() || !to_ms.is_finite() || to_ms <= from_ms {
        return Ok(TemporalSelection::default());
    }
    let duration = (to_ms - from_ms).max(1.0);
    let bins = crate::json::saturating_i64(duration.floor().clamp(1.0, 8.0));
    let rows = match time.basis {
        RecallTimeBasis::Conversation => conversation::select(db, input, from_ms, duration, bins)?,
        RecallTimeBasis::Event => event::select(db, input, time, from_ms, duration, bins)?,
    };
    let mut episode_seen = HashSet::new();
    let mut seed_seen = HashSet::new();
    let mut selection = TemporalSelection::default();
    for (episode_id, node_id) in rows {
        if episode_seen.insert(episode_id.clone()) {
            selection.episode_ids.push(episode_id);
        }
        if let Some(node_id) = node_id
            && seed_seen.insert(node_id.clone())
            && selection.seeds.len() < 8
        {
            selection.seeds.push(node_id);
        }
    }
    Ok(selection)
}
