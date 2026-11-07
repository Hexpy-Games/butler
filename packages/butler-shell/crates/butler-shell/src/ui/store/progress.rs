//! `app/conversation-progress/*`: turn progress derived from the session view and live events.
//!
//! `TurnProgress` is the store's `turnProgress` map (`app/utils.ts` merges); the submodules are
//! the pure projections the transcript's activity units read: `activity` (`activity.ts`),
//! `rows` (`progress-rows.ts`), `tasks` (`composer-tasks.ts`), `terminal`
//! (`terminal-activity.ts`), `blocks` (the shared work-block reducer), `event` (the row a turn
//! event stands for) and `copy` (the `appCopy` strings and label functions they read).
pub(crate) mod activity;
pub(crate) mod blocks;
pub(crate) mod copy;
mod event;
mod fields;
pub(crate) mod labels;
mod merge;
mod ordinary;
mod public_text;
mod read_models;
pub(crate) mod row_ops;
pub(crate) mod rows;
mod snapshots;
pub(crate) mod tasks;
pub(crate) mod terminal;
mod tool_titles;

use serde_json::Value;

use self::event::progress_row_from_turn_event;
use self::snapshots::{
    Bucket, Snapshots, active_snapshot, merge_buckets, merge_from_latest, merge_snapshot_map,
};
use crate::ui::source::wire::{
    AgentTurnEvent, AppEventEnvelope, ProgressRow, SessionView, SessionViewTurn,
    TurnProgressSnapshot,
};

/// The turns' progress snapshots of the open session.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
#[derive(Default)]
pub(crate) struct TurnProgress {
    session_id: Option<String>,
    snapshots: Snapshots,
    /// `latestProgressTurnId`: the turn the last event named, which events without one join.
    latest_turn: Option<String>,
    /// The session's latest progress (`summary.latest_progress`).
    latest: Option<TurnProgressSnapshot>,
}

/// `turnProgressOf`: the turn's progress, or an empty snapshot of its state.
fn turn_progress_of(turn: &SessionViewTurn) -> TurnProgressSnapshot {
    turn.progress
        .clone()
        .unwrap_or_else(|| TurnProgressSnapshot {
            summary_reference: None,
            turn_id: None,
            started_at: None,
            summary: None,
            updated_at: Some(turn.updated_at.clone()),
            state: Some(turn.state.clone()),
            delivery_state: None,
            limitation_codes: None,
            limitations: None,
            safe_progress_rows: Vec::new(),
        })
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()
}

#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
impl TurnProgress {
    /// Rebuilds progress from a session view.
    pub(crate) fn load(&mut self, view: &SessionView) {
        if self.session_id.as_deref() != Some(view.session_id.as_str()) {
            self.session_id = Some(view.session_id.clone());
            self.snapshots.clear();
            self.latest_turn = None;
        }
        self.latest = None;
        let Some(turn) = &view.latest_turn else {
            return;
        };
        let started = |mut snapshot: TurnProgressSnapshot| {
            snapshot.started_at = Some(turn.created_at.clone());
            snapshot
        };
        if turn.progress.is_some() {
            let incoming: Snapshots = vec![(turn.id.clone(), started(turn_progress_of(turn)))];
            merge_snapshot_map(&mut self.snapshots, &incoming);
        }
        let latest = started(turn_progress_of(turn));
        merge_from_latest(&mut self.snapshots, &latest, Some(turn.state.as_str()));
        self.latest = Some(latest);
    }

    /// Applies a live event; returns whether progress changed.
    pub(crate) fn apply_event(&mut self, event: &AppEventEnvelope) -> bool {
        let Some(session) = self.session_id.clone() else {
            return false;
        };
        let mut bucket = Bucket::default();
        let Some(turn_id) = self.collect(event, &session, &mut bucket) else {
            return false;
        };
        self.latest_turn = Some(turn_id.clone());
        merge_buckets(&mut self.snapshots, &[(turn_id, bucket)])
    }

    /// The snapshot of a turn.
    pub(crate) fn snapshot(&self, turn_id: &str) -> Option<&TurnProgressSnapshot> {
        self.snapshots
            .iter()
            .find(|(id, _)| id == turn_id)
            .map(|(_, snapshot)| snapshot)
    }

    /// All snapshots, in the order they were first stored.
    pub(crate) fn snapshots(&self) -> &[(String, TurnProgressSnapshot)] {
        &self.snapshots
    }

    /// `activeTurnProgressSnapshot`: the newest turn still running.
    pub(crate) fn active(&self) -> Option<TurnProgressSnapshot> {
        active_snapshot(&self.snapshots, self.latest.as_ref())
    }

    /// `collectTimelineEventPatch` for one event: fills `bucket` and names the turn it is for.
    fn collect(
        &self,
        event: &AppEventEnvelope,
        session: &str,
        bucket: &mut Bucket,
    ) -> Option<String> {
        let payload = &event.payload;
        let named_turn = |turn_id: Option<&str>| {
            turn_id
                .map(str::to_string)
                .or_else(|| self.latest_turn.clone())
        };
        match event.r#type.as_str() {
            "message.created" | "message.updated" => {
                let message = payload.get("message")?;
                if text(message, "chat_id") != Some(session)
                    || text(message, "role") != Some("assistant")
                {
                    return None;
                }
                let turn_id = text(message, "turn_id").filter(|id| !id.is_empty())?;
                if event.r#type == "message.updated"
                    && payload.get("segment_completed") == Some(&Value::Bool(true))
                {
                    return None;
                }
                let status = text(message, "status")?;
                if !matches!(status, "delivered" | "failed" | "cancelled") {
                    return None;
                }
                note_state(bucket, status, None);
                Some(turn_id.to_string())
            }
            "turn.state_changed" => {
                let turn = payload.get("turn");
                let from_turn = |key: &str| turn.and_then(|turn| text(turn, key));
                if text(payload, "session_id").or_else(|| from_turn("chat_id")) != Some(session) {
                    return None;
                }
                let turn_id = text(payload, "turn_id").or_else(|| from_turn("id"));
                let state = text(payload, "state").or_else(|| from_turn("state"));
                let label =
                    text(payload, "safe_status_label").or_else(|| from_turn("safe_status_label"));
                let turn_id = named_turn(turn_id)?;
                if let Some(state) = state {
                    note_state(bucket, state, label);
                } else if let Some(label) = label {
                    bucket.label = Some(label.to_string());
                }
                Some(turn_id)
            }
            "progress.summary" | "agent.turn_event.progress" => {
                if text(payload, "session_id") != Some(session) {
                    return None;
                }
                let row: ProgressRow = serde_json::from_value(payload.get("row")?.clone()).ok()?;
                if row.id.is_empty() {
                    return None;
                }
                let turn_id = named_turn(text(payload, "turn_id"))?;
                append_row(bucket, row);
                Some(turn_id)
            }
            "agent.turn_event" => {
                let turn_event: AgentTurnEvent =
                    serde_json::from_value(payload.get("event")?.clone()).ok()?;
                if turn_event.sessionId != session {
                    return None;
                }
                let row = progress_row_from_turn_event(&turn_event)?;
                append_row(bucket, row);
                Some(turn_event.turnId)
            }
            _ => None,
        }
    }
}

/// `noteProgressState`.
fn note_state(bucket: &mut Bucket, state: &str, label: Option<&str>) {
    let previous = bucket.state.clone().unwrap_or_default();
    if state == "retrying" || merge::should_revive_for_retry(&previous, state) {
        bucket.revive_for_retry = true;
    }
    bucket.state = Some(state.to_string());
    if let Some(label) = label {
        bucket.label = Some(label.to_string());
    }
}

/// `appendProgressRow`.
fn append_row(bucket: &mut Bucket, row: ProgressRow) {
    if rows::is_internal_progress_row(&row) {
        return;
    }
    if !row_ops::is_terminal_state(&row.state) {
        bucket.state = Some(row.state.clone());
    }
    bucket.rows.push(row);
}
