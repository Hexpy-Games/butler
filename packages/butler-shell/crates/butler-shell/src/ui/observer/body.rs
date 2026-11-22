//! `SessionObserverBody` and `SessionObserverTimeline`: the observed session's activity rows and
//! replies in time order, each drawn by the renderer the conversation uses.
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use butler_ds::ui::blocks::message_row::{MessageRow, Role};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::layout::{Space, Stack};
use gpui::{Context, IntoElement as _, ParentElement as _, SharedString, Window};

use super::SessionObserver;
use crate::ui::chat::TranscriptCtx;
use crate::ui::chat::activity::child_views::sources;
use crate::ui::chat::activity::timeline::{expanded_state, timeline, turn_activity_panel};
use crate::ui::chat::grouped_message_row;
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{MessageRecord, MessageRecordRole, ProgressRow, SessionView};
use crate::ui::store::progress::activity::project_turn_activity;

/// One row of the observed transcript.
pub(super) enum Entry {
    /// A turn's activity (`SessionObserverActivityGroup`); `live` while it is the active turn.
    Activity {
        turn: String,
        rows: Vec<ProgressRow>,
        state: Option<String>,
        live: bool,
    },
    /// A reply, without the turn rows its activity row shows instead.
    Message(Arc<MessageRecord>),
}

/// `SessionObserverTimeline`: every source of `observerActivitySources` with phases (and the
/// active turn) becomes an activity row, sorted by time among the replies.
pub(super) fn entries(view: &SessionView, lang: Lang) -> Vec<Entry> {
    let mut items: Vec<(String, Entry)> = Vec::new();
    let mut work_blocks = HashMap::new();
    for source in sources(view) {
        let projection = project_turn_activity(lang, source.rows, Some(source.turn));
        let phased = !projection.phase_activities.is_empty();
        let live = view
            .active_turn
            .as_ref()
            .is_some_and(|turn| turn.id == source.turn);
        if phased || live {
            let state = view
                .latest_turn
                .as_ref()
                .filter(|turn| turn.id == source.turn)
                .map(|turn| turn.state.clone());
            let entry = Entry::Activity {
                turn: source.turn.to_owned(),
                rows: source.rows.to_vec(),
                state,
                live,
            };
            items.push((source.at.unwrap_or_default().to_owned(), entry));
        }
        // Work blocks stand in only for a turn without phases.
        work_blocks.insert(source.turn, (!phased).then_some(projection.work_blocks));
    }
    for message in &view.messages {
        // A steward's own prompt is hidden (`message.role !== "user"` when it has a relation).
        if view.relation.is_some() && message.role == MessageRecordRole::User {
            continue;
        }
        let mut reply = MessageRecord::clone(message);
        reply.turn_activity_rows = None;
        if let Some(blocks) = reply
            .turn_id
            .as_deref()
            .and_then(|turn| work_blocks.get(turn))
        {
            reply.work_blocks.clone_from(blocks);
        }
        let at = message.created_at.clone().unwrap_or_default();
        items.push((at, Entry::Message(Arc::new(reply))));
    }
    items.sort_by(|a, b| a.0.cmp(&b.0));
    items.into_iter().map(|(_, entry)| entry).collect()
}

impl SessionObserver {
    /// The rows in order, over the view's own transcript context: no list reserve, top inset,
    /// tail-follow or answer footer
    /// (`SessionObserverTimeline` passes no `onCopyAssistantMessage` and `footerMeta={null}`).
    pub(super) fn transcript(
        &mut self,
        view: &Rc<SessionView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Stack {
        let mut t = TranscriptCtx::new(view, Jobs::client(cx), Rc::default(), Rc::default());
        t.status_line.clone_from(&self.status_line);
        t.answer_footer = false;
        let lang = Ds::get(cx).lang();
        let mut target = self.target.take();
        // `delegatedGoal`: the first activity entry carries the child's title.
        let mut goal = view
            .relation
            .as_ref()
            .map(|relation| relation.safe_title.as_str());
        // `MessageTurnGroup`: a `--space-lg` stack whose rows carry no bottom padding.
        let mut column = Stack::new().gap(Space::Lg);
        for entry in &self.entries {
            let row = match entry {
                Entry::Message(message) => Some(grouped_message_row(message, &t, window, cx)),
                Entry::Activity {
                    turn,
                    rows,
                    state,
                    live,
                } => {
                    if target.as_deref() == Some(turn.as_str()) {
                        target = None;
                        open_activity(rows, turn, lang, window, cx);
                    }
                    t.goal = goal.take();
                    let panel = if *live {
                        turn_activity_panel(rows, Some(turn), &t, window, cx)
                    } else {
                        timeline(rows, Some(turn), state.as_deref(), false, &t, window, cx)
                    };
                    panel.map(|panel| {
                        let id = SharedString::from(format!("steward-observer-activity-{turn}"));
                        MessageRow::new(id, Role::Assistant)
                            .grouped()
                            .child(panel)
                            .into_any_element()
                    })
                }
            };
            column = column.children(row);
        }
        self.target = target;
        column
    }
}

/// The open effect of `SessionObserverDialog`: the target turn's activity opens.
fn open_activity(
    rows: &[ProgressRow],
    turn: &str,
    lang: Lang,
    window: &mut Window,
    cx: &mut gpui::App,
) {
    let projection = project_turn_activity(lang, rows, Some(turn));
    if let Some(first) = projection.phase_activities.first() {
        expanded_state(&first.id, window, cx).update(cx, |open, cx| {
            *open = true;
            cx.notify();
        });
    }
}
