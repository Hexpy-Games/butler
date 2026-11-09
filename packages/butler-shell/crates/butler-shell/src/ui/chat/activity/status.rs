//! `CurrentTurnStatus`, `CurrentStatusText`, `CurrentModelRoundWaiting`, `AssistantStatusLabel`.
use butler_ds::ui::motion;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use butler_ds::tokens::Length;
use butler_ds::ui::blocks::message_row::MessageStatusLabel;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::rolling_status_line::RollingStatusLine;
use butler_ds::ui::rolling_swap::RollingSwap;
use butler_ds::ui::thinking_mark::{ButlerThinkingMark, MarkState};
use butler_ds::ui::typo::{Role, Tone, Typo};
use gpui::{
    AnyElement, AnyView, App, AppContext as _, Context, ElementId, Entity, IntoElement as _,
    ParentElement as _, Render, SharedString, StyleRefinement, Styled as _, Window,
};

use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::{ProgressRow, SessionView};
use crate::ui::store::progress::activity::project_turn_activity;
use crate::ui::store::progress::copy::{copy, interface_progress_label, public_operation_title};
use crate::ui::store::progress::labels::elapsed;

/// `CurrentTurnStatus`' props.
#[derive(PartialEq)]
struct Status {
    /// Same key across remounts of one turn's status keeps the mark's morph going.
    mark_key: SharedString,
    thinking_line: Option<String>,
    operation: Option<ProgressRow>,
    model_round_wait: Option<ProgressRow>,
    public_activity: Option<ProgressRow>,
    phase_label: Option<String>,
    started_at: Option<String>,
    state: Option<String>,
    waiting_for_answer: bool,
    /// The active authority approval's tool (`useWaitingLabel`).
    handoff_tool: Option<String>,
    /// 대화's current tool replaces the step and model-wait labels.
    activity_label: Option<String>,
}

/// The clock and the status line's motions invalidate only this view.
pub(crate) struct StatusLineView {
    status: Status,
    lang: Lang,
    id: ElementId,
}

impl StatusLineView {
    /// The transcript owns this entity for as long as its turn's status line shows.
    pub(crate) fn sync(entity: &mut Option<Entity<Self>>, view: &SessionView, cx: &mut App) {
        let lang = Ds::get(cx).lang();
        let Some((status, id)) = status_data(view, lang) else {
            *entity = None;
            return;
        };
        if let Some(entity) = entity.as_ref().filter(|entity| entity.read(cx).id == id) {
            if entity.read(cx).status != status || entity.read(cx).lang != lang {
                entity.update(cx, |view, cx| {
                    view.status = status;
                    view.lang = lang;
                    cx.notify();
                });
            }
        } else {
            *entity = Some(cx.new(|_| Self { status, lang, id }));
        }
    }
}

impl Render for StatusLineView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl gpui::IntoElement {
        keep_time(
            sub(&self.id, "clock"),
            self.status.started_at.is_some() || self.status.model_round_wait.is_some(),
            window,
            cx,
        );
        current_turn_status_line(&self.status, &self.id, self.lang)
    }
}

/// The running turn's status line; `None` when no turn runs.
pub(crate) fn current_turn_status(t: &TranscriptCtx, cx: &App) -> Option<AnyElement> {
    let entity = t.status_line.clone()?;
    let style = StyleRefinement::default()
        .h(Ds::get(cx).len(Length::TypoBodyLineHeight))
        .min_w_0();
    Some(AnyView::from(entity).cached(style).into_any_element())
}

fn status_data(view: &SessionView, lang: Lang) -> Option<(Status, ElementId)> {
    let turn = view.active_turn.as_ref()?;
    // `useThinkingRows` with thinking hidden: rows that only carry a thinking summary drop out.
    let rows: Vec<ProgressRow> = turn
        .progress
        .iter()
        .flat_map(|progress| progress.safe_progress_rows.iter())
        .filter(|row| row.thinking_title.is_none())
        .cloned()
        .collect();
    let projection = project_turn_activity(lang, &rows, Some(&turn.id));
    let handoff_tool = view
        .authority_requests
        .iter()
        .flatten()
        .next()
        .and_then(|request| request.pointer("/approval/operation/tool"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let status = Status {
        mark_key: SharedString::from(format!("turn-status:{}", turn.id)),
        thinking_line: None,
        operation: projection.operation,
        model_round_wait: projection.model_round_wait,
        public_activity: projection.public_activity,
        phase_label: projection
            .phase_activities
            .last()
            .map(|activity| activity.summary.clone()),
        started_at: Some(turn.created_at.clone()),
        state: Some(turn.state.clone()),
        waiting_for_answer: rows
            .iter()
            .any(|row| row.safe_tool_name.as_deref() == Some("ask_user")),
        handoff_tool,
        activity_label: None,
    };
    let id = ElementId::from(SharedString::from(format!("turn-status-line:{}", turn.id)));
    Some((status, id))
}

fn sub(id: &ElementId, name: &'static str) -> ElementId {
    ElementId::from((id.clone(), name))
}

/// `useWaitingLabel`: what a waiting turn waits on (an answer, the user's step in a browser
/// tab, or an approval).
fn waiting_label(lang: Lang, waiting_for_answer: bool, handoff_tool: Option<&str>) -> &'static str {
    let copy = copy(lang);
    if waiting_for_answer {
        return copy.answer_waiting;
    }
    match handoff_tool {
        Some("browser_sign_in_wait") => copy.sign_in_waiting,
        Some("browser_wait_for_user" | "browser_pay_wait") => copy.tab_waiting,
        _ => copy.approval_waiting,
    }
}

/// `useElapsedTime`'s text for `started_at`, empty when there is no valid start.
fn elapsed_since(lang: Lang, started_at: Option<&str>) -> String {
    let Some(started) = started_at
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .map(|at| at.timestamp_millis())
    else {
        return String::new();
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| i64::try_from(since.as_millis()).unwrap_or(0));
    let seconds = (now - started).max(0) / 1000;
    elapsed(lang, u64::try_from(seconds).unwrap_or(0))
}

/// `label · suffix`, or the label alone when there is no suffix.
fn with_suffix(label: &str, suffix: &str) -> String {
    if suffix.is_empty() {
        label.to_string()
    } else {
        format!("{label} · {suffix}")
    }
}

struct Clock {
    pending: bool,
}

/// The one-second tick `useElapsedTime` runs while a start time is set: the status re-renders
/// each second and stops when it leaves the screen.
fn keep_time(id: ElementId, running: bool, window: &mut Window, cx: &mut App) {
    let clock = window.use_keyed_state(id, cx, |_, _| Clock { pending: false });
    if !running || clock.read(cx).pending {
        return;
    }
    clock.update(cx, |clock, _| clock.pending = true);
    let clock = clock.downgrade();
    window
        .spawn(cx, async move |cx| {
            motion::sleep(cx.background_executor(), Duration::from_secs(1)).await;
            cx.update(|_, cx| {
                clock
                    .update(cx, |clock, cx| {
                        clock.pending = false;
                        cx.notify();
                    })
                    .ok();
            })
            .ok();
        })
        .detach();
}

/// The status text and, when a model summary line is showing, that line: what
/// `CurrentTurnStatus` picks among its cases (`CurrentStatusText`, `CurrentModelRoundWaiting`).
fn resolve(status: &Status, lang: Lang) -> (String, Option<&str>) {
    let copy = copy(lang);
    let elapsed = elapsed_since(lang, status.started_at.as_deref());
    let operation_label = status.operation.as_ref().map(|operation| {
        let label = interface_progress_label(lang, operation);
        if label.is_empty() {
            public_operation_title(lang, operation.safe_tool_name.as_deref())
        } else {
            label
        }
    });
    let provider_recovery = status
        .public_activity
        .as_ref()
        .filter(|row| row.bridge_phase.as_deref() == Some("operational_recovery"));
    let waiting_for_approval = status.state.as_deref() == Some("waiting_for_form");
    let waiting = waiting_label(
        lang,
        status.waiting_for_answer,
        status.handoff_tool.as_deref(),
    );
    let activity = status
        .activity_label
        .as_deref()
        .filter(|_| !waiting_for_approval && provider_recovery.is_none());
    let summary_line = status.thinking_line.as_deref().filter(|_| {
        !waiting_for_approval
            && status.operation.is_none()
            && provider_recovery.is_none()
            && activity.is_none()
            && status.model_round_wait.is_some()
    });
    let label_of = |row: &ProgressRow| interface_progress_label(lang, row);
    let full_label = if waiting_for_approval {
        waiting.to_string()
    } else {
        activity
            .map(str::to_string)
            .or_else(|| operation_label.clone())
            .or_else(|| provider_recovery.map(label_of))
            .or_else(|| {
                status
                    .model_round_wait
                    .as_ref()
                    .map(|_| summary_line.unwrap_or(copy.generating).to_string())
            })
            .or_else(|| status.public_activity.as_ref().map(label_of))
            .or_else(|| status.phase_label.clone())
            .unwrap_or_else(|| copy.generating.to_string())
    };
    let text = if waiting_for_approval {
        full_label
    } else if let Some(activity) = activity {
        with_suffix(activity, &elapsed)
    } else if let Some(label) = &operation_label {
        label.clone()
    } else if let Some(row) = provider_recovery {
        label_of(row)
    } else if let Some(wait) = &status.model_round_wait {
        let waited = elapsed_since(lang, wait.created_at.as_deref());
        with_suffix(summary_line.unwrap_or(copy.generating), &waited)
    } else if let Some(row) = &status.public_activity {
        label_of(row)
    } else if let Some(phase) = &status.phase_label {
        phase.clone()
    } else {
        with_suffix(&full_label, &elapsed)
    };
    (text, summary_line)
}

/// `CurrentTurnStatus`.
fn current_turn_status_line(status: &Status, id: &ElementId, lang: Lang) -> AnyElement {
    let (text, summary_line) = resolve(status, lang);
    let mark = ButlerThinkingMark::new(sub(id, "mark"))
        .state(MarkState::Working)
        .morph_key(status.mark_key.clone());
    let label = MessageStatusLabel::new(sub(id, "label"), mark);
    let label = match summary_line {
        // A summary line rolls in as its text changes.
        Some(line) => {
            let rolling = SharedString::from(text);
            label.child(
                RollingSwap::new(
                    sub(id, "swap"),
                    SharedString::from(line.to_string()),
                    move |_, _| {
                        Typo::body(rolling.clone())
                            .tone(Tone::Secondary)
                            .truncate()
                            .into_any_element()
                    },
                )
                .motion(true),
            )
        }
        None => label.shimmer(Role::Body, text),
    };
    RollingStatusLine::new().child(label).into_any_element()
}
