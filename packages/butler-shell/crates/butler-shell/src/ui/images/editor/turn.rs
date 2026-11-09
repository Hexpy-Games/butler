//! `useImageEditTurn.ts`: watches the accepted edit turn only, so unrelated edits cannot
//! become this editor's result. The turn's progress comes from the session view, read again
//! when the session's live topic moves.
use std::rc::Rc;

use butler_ds::ui::toast::{self, Toast};
use gpui::{Context, SharedString};
use serde::Deserialize;

use super::ImageEditor;
use crate::ui::images::{ImageAsset, ImageToolRow, outputs};
use crate::ui::source::fetch::{Flight, fetch_if};

const TERMINAL: [&str; 5] = ["delivered", "completed", "failed", "cancelled", "denied"];

/// The edit turn of one editor.
#[derive(Default)]
pub(super) struct EditTurn {
    turn: Option<SharedString>,
    rows: Vec<ImageToolRow>,
    revision: SharedString,
    ended: bool,
    rejected: bool,
    /// The picture the turn made from the shown one.
    pub(super) result: Option<Rc<ImageAsset>>,
    flight: Flight,
    /// The session topic's revision as last read.
    pub(super) seen: u64,
}

impl EditTurn {
    pub(super) fn generating(&self) -> bool {
        self.turn.is_some()
    }

    /// `shown`: the result is on screen; the turn is over.
    pub(super) fn shown(&mut self) {
        *self = Self {
            seen: self.seen,
            ..Self::default()
        };
    }
}

/// The slice of the session view the turn is read from.
#[derive(Deserialize)]
struct View {
    #[serde(default)]
    active_turn: Option<Active>,
    #[serde(default)]
    messages: Vec<Message>,
}

#[derive(Deserialize)]
struct Active {
    id: String,
    state: String,
    #[serde(default)]
    progress: Option<Progress>,
}

#[derive(Deserialize)]
struct Progress {
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    safe_progress_rows: Vec<Row>,
}

#[derive(Deserialize)]
struct Message {
    role: String,
    #[serde(default)]
    turn_id: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    turn_activity_rows: Option<Vec<Row>>,
}

#[derive(Deserialize)]
struct Row {
    #[serde(default)]
    safe_tool_name: Option<String>,
    #[serde(default)]
    tool_call_id: Option<String>,
    #[serde(default)]
    tool_result_id: Option<String>,
    #[serde(default)]
    state: String,
    #[serde(default)]
    failure_code: Option<String>,
}

/// What the view says of the turn.
struct Seen {
    rows: Vec<Row>,
    revision: String,
    ended: bool,
}

fn read_view(view: View, turn: &str) -> Seen {
    let message = view
        .messages
        .into_iter()
        .find(|m| m.role == "assistant" && m.turn_id.as_deref() == Some(turn));
    let active = view.active_turn.filter(|active| active.id == turn);
    let progress_state = active.as_ref().map(|active| {
        active
            .progress
            .as_ref()
            .and_then(|p| p.state.clone())
            .unwrap_or_else(|| active.state.clone())
    });
    let message_status = message.as_ref().and_then(|m| m.status.clone());
    let ended = [progress_state.as_deref(), message_status.as_deref()]
        .into_iter()
        .flatten()
        .any(|state| TERMINAL.contains(&state));
    let revision = format!(
        "{}:{}:{}:{}",
        progress_state.as_deref().unwrap_or_default(),
        active
            .as_ref()
            .and_then(|a| a.progress.as_ref())
            .and_then(|p| p.updated_at.as_deref())
            .unwrap_or_default(),
        message_status.as_deref().unwrap_or_default(),
        message
            .as_ref()
            .and_then(|m| m.updated_at.as_deref())
            .unwrap_or_default(),
    );
    let rows = match message.and_then(|m| m.turn_activity_rows) {
        Some(rows) => rows,
        None => active
            .and_then(|a| a.progress)
            .map(|p| p.safe_progress_rows)
            .unwrap_or_default(),
    };
    Seen {
        rows,
        revision,
        ended,
    }
}

/// The image tool rows with a result to read, as the transcript lists them.
fn tool_rows(rows: &[Row]) -> Vec<ImageToolRow> {
    let mut tools: Vec<ImageToolRow> = Vec::new();
    for row in rows {
        let tool = row.safe_tool_name.as_deref().unwrap_or_default();
        let (Some(call), Some(result)) =
            (row.tool_call_id.as_deref(), row.tool_result_id.as_deref())
        else {
            continue;
        };
        if !matches!(tool, "generate_image" | "edit_image")
            || tools.iter().any(|known| known.call_id.as_ref() == call)
        {
            continue;
        }
        tools.push(ImageToolRow {
            call_id: call.to_owned().into(),
            result_id: result.to_owned().into(),
            tool: tool.to_owned().into(),
            failed: tool == "edit_image" && (row.state == "failed" || row.failure_code.is_some()),
        });
    }
    tools
}

impl ImageEditor {
    /// `accepted`: the send was taken as this turn.
    pub(super) fn turn_accepted(&mut self, turn: String, cx: &mut Context<Self>) {
        self.turn.turn = Some(turn.into());
        self.turn.result = None;
        self.refresh_turn(cx);
    }

    /// Reads the session view for the turn's progress; one read at a time.
    pub(super) fn refresh_turn(&mut self, cx: &mut Context<Self>) {
        let Some(turn) = self.turn.turn.clone() else {
            return;
        };
        if !self.turn.flight.begin() {
            return;
        }
        let session = self.session.to_string();
        fetch_if(
            cx,
            move |client| async move { client.message_window(&session, None, 100).await },
            move |this: &mut Self, result: Result<View, butler_shell_client::Error>, cx| {
                let more = this.turn.flight.end();
                let changed = match result {
                    Ok(view) if this.turn.turn.as_ref() == Some(&turn) => {
                        this.take_view(view, &turn)
                    }
                    _ => false,
                };
                if more {
                    this.refresh_turn(cx);
                }
                changed
            },
        );
    }

    fn take_view(&mut self, view: View, turn: &str) -> bool {
        let seen = read_view(view, turn);
        let rows = tool_rows(&seen.rows);
        let rejected = seen.rows.iter().any(|row| {
            row.safe_tool_name.as_deref() == Some("edit_image")
                && matches!(row.state.as_str(), "denied" | "cancelled")
        });
        let state = &mut self.turn;
        let changed = state.rows != rows
            || state.revision.as_ref() != seen.revision
            || state.ended != seen.ended
            || state.rejected != rejected;
        state.rows = rows;
        state.revision = seen.revision.into();
        state.ended = seen.ended;
        state.rejected = rejected;
        changed
    }

    /// The effect of `useImageEditTurn`, run before each draw: the result appears, or the turn
    /// ends (with a toast when it failed).
    pub(super) fn sync_turn(&mut self, cx: &mut gpui::App) {
        let Some(turn) = self.turn.turn.clone() else {
            return;
        };
        let read = outputs::read(Some(&turn), &self.turn.rows, &self.turn.revision, cx);
        if read.loading {
            return;
        }
        let shown = self.asset.id.as_str();
        if let Some(next) = read
            .images
            .iter()
            .find(|a| a.parent_id.as_deref() == Some(shown))
        {
            self.turn.result = Some(next.clone());
            return;
        }
        if self.turn.ended && (!read.unavailable || read.failed || self.turn.rejected) {
            self.turn.turn = None;
            if read.failed {
                toast::show(cx, Toast::error(Self::copy(cx).failed));
            }
        }
    }
}
