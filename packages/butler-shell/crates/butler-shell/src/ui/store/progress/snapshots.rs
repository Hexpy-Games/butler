//! `app/utils.ts`: the per-turn progress snapshots and how they merge.
use super::merge::{
    merge_progress_rows, progress_merge_state, rows_for_merged_terminal_state,
    should_revive_for_retry, timestamp_ms,
};
use super::row_ops::is_terminal_state;
use super::rows::is_internal_progress_row;
use crate::ui::source::wire::{ProgressRow, TurnProgressSnapshot};

/// `turnProgress`: the snapshots by turn id, in the order they were first stored.
pub(crate) type Snapshots = Vec<(String, TurnProgressSnapshot)>;

const MAX_TURN_PROGRESS_SNAPSHOTS: usize = 80;

/// `TimelineProgressBucket`: what the events of one turn add.
#[derive(Default)]
pub(super) struct Bucket {
    pub(super) rows: Vec<ProgressRow>,
    pub(super) state: Option<String>,
    pub(super) label: Option<String>,
    pub(super) revive_for_retry: bool,
}

fn find<'a>(snapshots: &'a Snapshots, turn_id: &str) -> Option<&'a TurnProgressSnapshot> {
    snapshots
        .iter()
        .find(|(id, _)| id == turn_id)
        .map(|(_, snapshot)| snapshot)
}

fn put(snapshots: &mut Snapshots, turn_id: &str, snapshot: TurnProgressSnapshot) {
    match snapshots.iter_mut().find(|(id, _)| id == turn_id) {
        Some(slot) => slot.1 = snapshot,
        None => snapshots.push((turn_id.to_string(), snapshot)),
    }
}

/// `{...base, ...top}` of two snapshots (rows are the caller's to set).
fn overlay(base: &TurnProgressSnapshot, top: &TurnProgressSnapshot) -> TurnProgressSnapshot {
    TurnProgressSnapshot {
        summary_reference: top
            .summary_reference
            .clone()
            .or_else(|| base.summary_reference.clone()),
        turn_id: top.turn_id.clone().or_else(|| base.turn_id.clone()),
        started_at: top.started_at.clone().or_else(|| base.started_at.clone()),
        summary: top.summary.clone().or_else(|| base.summary.clone()),
        updated_at: top.updated_at.clone().or_else(|| base.updated_at.clone()),
        state: top.state.clone().or_else(|| base.state.clone()),
        delivery_state: top
            .delivery_state
            .clone()
            .or_else(|| base.delivery_state.clone()),
        limitation_codes: top
            .limitation_codes
            .clone()
            .or_else(|| base.limitation_codes.clone()),
        limitations: top.limitations.clone().or_else(|| base.limitations.clone()),
        safe_progress_rows: top.safe_progress_rows.clone(),
    }
}

/// `turnProgressSnapshotActivityMs`: the newest time the snapshot or its rows carry.
fn activity_ms(snapshot: &TurnProgressSnapshot) -> f64 {
    std::iter::once(timestamp_ms(snapshot.updated_at.as_deref()))
        .chain(
            snapshot
                .safe_progress_rows
                .iter()
                .map(|row| timestamp_ms(row.created_at.as_deref())),
        )
        .flatten()
        .fold(0., f64::max)
}

/// `shouldPreserveActiveSnapshotOverStaleTerminal`.
fn preserve_active_over_stale_terminal(
    current: &TurnProgressSnapshot,
    incoming: &TurnProgressSnapshot,
    current_state: &str,
    incoming_state: &str,
) -> bool {
    let same_turn = matches!((&current.turn_id, &incoming.turn_id), (Some(a), Some(b)) if a == b);
    if !same_turn || current_state.is_empty() || is_terminal_state(current_state) {
        return false;
    }
    if incoming_state != "failed" && incoming_state != "cancelled" {
        return false;
    }
    let (current_ms, incoming_ms) = (activity_ms(current), activity_ms(incoming));
    current_ms > 0. && incoming_ms > 0. && incoming_ms < current_ms
}

/// `newestTimestamp`.
fn newest_timestamp(left: Option<&str>, right: Option<&str>) -> Option<String> {
    let (Some(l), Some(r)) = (left, right) else {
        return left.or(right).map(str::to_string);
    };
    let newer_right = match (timestamp_ms(Some(l)), timestamp_ms(Some(r))) {
        (Some(left_ms), Some(right_ms)) => right_ms >= left_ms,
        _ => r >= l,
    };
    let newest = if newer_right { r } else { l };
    Some(newest.to_string())
}

/// `capTurnProgressSnapshots`: keeps the newest [`MAX_TURN_PROGRESS_SNAPSHOTS`].
fn cap(snapshots: &mut Snapshots) {
    if snapshots.len() <= MAX_TURN_PROGRESS_SNAPSHOTS {
        return;
    }
    let updated_at = |snapshot: &TurnProgressSnapshot| {
        snapshot
            .updated_at
            .clone()
            .or_else(|| {
                snapshot
                    .safe_progress_rows
                    .last()
                    .and_then(|row| row.created_at.clone())
            })
            .unwrap_or_default()
    };
    let mut ranked: Vec<(usize, String)> = snapshots
        .iter()
        .enumerate()
        .map(|(index, (_, snapshot))| (index, updated_at(snapshot)))
        .collect();
    ranked.sort_by(|left, right| left.1.cmp(&right.1).then(left.0.cmp(&right.0)));
    let kept: Snapshots = ranked[ranked.len() - MAX_TURN_PROGRESS_SNAPSHOTS..]
        .iter()
        .map(|(index, _)| snapshots[*index].clone())
        .collect();
    *snapshots = kept;
}

/// `mergeTurnProgressBuckets`: what the events of each turn add to the snapshots.
pub(super) fn merge_buckets(snapshots: &mut Snapshots, buckets: &[(String, Bucket)]) -> bool {
    let mut changed = false;
    for (turn_id, bucket) in buckets {
        if turn_id.is_empty() {
            continue;
        }
        let previous = find(snapshots, turn_id).cloned();
        let previous_state = previous
            .as_ref()
            .and_then(|p| p.state.clone())
            .unwrap_or_default();
        let bucket_state = bucket.state.clone().unwrap_or_default();
        let revive =
            bucket.revive_for_retry || should_revive_for_retry(&previous_state, &bucket_state);
        let state_for_merge = if revive { "" } else { previous_state.as_str() };
        let previous_rows = previous
            .as_ref()
            .map(|p| p.safe_progress_rows.clone())
            .unwrap_or_default();
        let safe_rows: Vec<ProgressRow> = bucket
            .rows
            .iter()
            .filter(|row| !is_internal_progress_row(row))
            .cloned()
            .collect();
        let merged = if safe_rows.is_empty() {
            previous_rows
        } else {
            merge_progress_rows(&previous_rows, &safe_rows, revive)
        };
        let next_state = match &bucket.state {
            Some(state) => Some(progress_merge_state(state_for_merge, state)),
            None => previous.as_ref().and_then(|p| p.state.clone()),
        };
        let rows = rows_for_merged_terminal_state(merged, next_state.as_deref());
        let bucket_state_wins = bucket
            .state
            .as_deref()
            .is_some_and(|state| progress_merge_state(state_for_merge, state) == state);
        let mut snapshot = previous.clone().unwrap_or_else(empty_snapshot);
        snapshot.turn_id = Some(turn_id.clone());
        snapshot.safe_progress_rows = rows;
        if next_state.is_some() {
            snapshot.state = next_state;
        }
        if let Some(label) = &bucket.label
            && (previous.is_none() || bucket_state_wins)
        {
            snapshot.summary = Some(label.clone());
        }
        if previous.as_ref() == Some(&snapshot) {
            continue;
        }
        put(snapshots, turn_id, snapshot);
        changed = true;
    }
    if changed {
        cap(snapshots);
    }
    changed
}

fn empty_snapshot() -> TurnProgressSnapshot {
    TurnProgressSnapshot {
        summary_reference: None,
        turn_id: None,
        started_at: None,
        summary: None,
        updated_at: None,
        state: None,
        delivery_state: None,
        limitation_codes: None,
        limitations: None,
        safe_progress_rows: Vec::new(),
    }
}

fn safe_rows(rows: &[ProgressRow]) -> Vec<ProgressRow> {
    rows.iter()
        .filter(|row| !is_internal_progress_row(row))
        .cloned()
        .collect()
}

/// `mergeTurnProgressSnapshotMap`: a fetched view's snapshots merged into the stored ones.
pub(super) fn merge_snapshot_map(snapshots: &mut Snapshots, incoming: &Snapshots) -> bool {
    let mut changed = false;
    for (turn_id, snapshot) in incoming {
        if turn_id.is_empty() {
            continue;
        }
        let rows = safe_rows(&snapshot.safe_progress_rows);
        let mut incoming_snapshot = snapshot.clone();
        incoming_snapshot.turn_id =
            Some(snapshot.turn_id.clone().unwrap_or_else(|| turn_id.clone()));
        incoming_snapshot.safe_progress_rows = rows.clone();
        let Some(previous) = find(snapshots, turn_id).cloned() else {
            put(snapshots, turn_id, incoming_snapshot);
            changed = true;
            continue;
        };
        let incoming_state = snapshot.state.clone().unwrap_or_default();
        let previous_state = previous.state.clone().unwrap_or_default();
        if preserve_active_over_stale_terminal(
            &previous,
            &incoming_snapshot,
            &previous_state,
            &incoming_state,
        ) {
            continue;
        }
        let revive = should_revive_for_retry(&previous_state, &incoming_state);
        let state_for_merge = if revive { "" } else { previous_state.as_str() };
        let next_state = if incoming_state.is_empty() {
            previous.state.clone()
        } else {
            Some(progress_merge_state(state_for_merge, &incoming_state))
        };
        let incoming_wins = !incoming_state.is_empty()
            && progress_merge_state(state_for_merge, &incoming_state) == incoming_state;
        let mut next = if incoming_wins {
            overlay(&previous, snapshot)
        } else {
            overlay(snapshot, &previous)
        };
        next.turn_id = Some(turn_id.clone());
        if next_state.is_some() {
            next.state = next_state;
        }
        next.updated_at = newest_timestamp(
            previous.updated_at.as_deref(),
            snapshot.updated_at.as_deref(),
        )
        .or(next.updated_at);
        next.safe_progress_rows = merge_progress_rows(&previous.safe_progress_rows, &rows, revive);
        if next == previous {
            continue;
        }
        put(snapshots, turn_id, next);
        changed = true;
    }
    if changed {
        cap(snapshots);
    }
    changed
}

/// `previousRowsForAuthoritativeTodoSnapshot`.
fn previous_rows_for_todo_snapshot(
    previous: &[ProgressRow],
    incoming: &[ProgressRow],
) -> Vec<ProgressRow> {
    let todos: Vec<&ProgressRow> = incoming
        .iter()
        .filter(|row| row.kind.as_deref() == Some("todo"))
        .collect();
    let unnamed = |row: &&ProgressRow| {
        row.safe_input_label
            .as_deref()
            .is_none_or(|label| label.trim().is_empty())
    };
    if todos.is_empty() || todos.iter().any(unnamed) {
        return previous.to_vec();
    }
    previous
        .iter()
        .filter(|row| row.kind.as_deref() != Some("todo"))
        .cloned()
        .collect()
}

/// `mergeTurnProgressFromSummary`: the session's latest progress merged into the snapshots.
pub(super) fn merge_from_latest(
    snapshots: &mut Snapshots,
    latest: &TurnProgressSnapshot,
    turn_state: Option<&str>,
) -> bool {
    let Some(turn_id) = latest.turn_id.clone().filter(|id| !id.is_empty()) else {
        return false;
    };
    let rows = safe_rows(&latest.safe_progress_rows);
    let previous = find(snapshots, &turn_id).cloned();
    let incoming_state = latest
        .state
        .clone()
        .or_else(|| turn_state.map(str::to_string))
        .unwrap_or_default();
    let mut incoming = latest.clone();
    incoming.safe_progress_rows = rows.clone();
    let previous_state = previous
        .as_ref()
        .and_then(|p| p.state.clone())
        .unwrap_or_default();
    if let Some(previous) = &previous
        && preserve_active_over_stale_terminal(
            previous,
            &incoming,
            &previous_state,
            &incoming_state,
        )
    {
        return false;
    }
    let revive = should_revive_for_retry(&previous_state, &incoming_state);
    let state_for_merge = if revive { "" } else { previous_state.as_str() };
    let next_state = if incoming_state.is_empty() {
        previous.as_ref().and_then(|p| p.state.clone())
    } else {
        Some(progress_merge_state(state_for_merge, &incoming_state))
    };
    let incoming_wins = incoming_state.is_empty()
        || progress_merge_state(state_for_merge, &incoming_state) == incoming_state;
    let mut next = match (&previous, incoming_wins) {
        (None, _) => latest.clone(),
        (Some(previous), true) => overlay(previous, latest),
        (Some(previous), false) => overlay(latest, previous),
    };
    let previous_rows = previous
        .as_ref()
        .map(|p| previous_rows_for_todo_snapshot(&p.safe_progress_rows, &rows))
        .unwrap_or_default();
    let merged = merge_progress_rows(&previous_rows, &rows, revive);
    next.turn_id = Some(turn_id.clone());
    if next_state.is_some() {
        next.state = next_state.clone();
    }
    next.safe_progress_rows = rows_for_merged_terminal_state(merged, next_state.as_deref());
    if previous.as_ref() == Some(&next) {
        return false;
    }
    put(snapshots, &turn_id, next);
    cap(snapshots);
    true
}
