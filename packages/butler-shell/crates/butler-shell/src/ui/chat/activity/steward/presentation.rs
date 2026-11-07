//! `stewardProgressPresentation.ts`, `stewardParentProgressProjection.ts`, and the work-block
//! status lines (`workBlockLatestStatus.ts`, `workBlockTail.ts`) the card shows.
use butler_ds::ui::context::Lang;

use crate::ui::chat::activity::timeline::display_title;
use crate::ui::source::wire::{
    MessageRecord, MessageRecordRole, ProgressRow, SessionView, SessionViewStatus, SessionViewTurn,
    StewardResultViewStatus, StewardSessionSummaryView, WorkPlanActionStatus,
};
use crate::ui::store::progress::activity::project_turn_activity;
use crate::ui::store::progress::copy::{
    copy, interface_progress_label, interface_text, public_operation_title, tool_fallback,
    tool_title,
};
use crate::ui::store::progress::labels::{
    phase_label, plan_compact, plan_delivered, plan_failed, plan_running,
};

/// `AnchoredStewardProgress`.
pub(super) struct Anchored<'a> {
    pub(super) child: &'a StewardSessionSummaryView,
    pub(super) turn: &'a SessionViewTurn,
    pub(super) rows: &'a [ProgressRow],
}

/// The assistant message that owns a child's card: both durable relation anchors must hold.
fn anchored_parent<'a>(
    messages: &'a [MessageRecord],
    session_id: &str,
    child: &StewardSessionSummaryView,
) -> Option<&'a MessageRecord> {
    let relation = &child.relation;
    if relation.child_session_id != child.session_id {
        return None;
    }
    let anchor_index = messages
        .iter()
        .position(|message| message.id == relation.anchor_message_id)?;
    let anchor = &messages[anchor_index];
    if anchor.role != MessageRecordRole::User || anchor.chat_id.as_deref() != Some(session_id) {
        return None;
    }
    let parent_index = (anchor_index + 1..messages.len()).find(|at| {
        messages[*at].role == MessageRecordRole::Assistant
            && messages[*at].turn_id.as_deref() == Some(relation.parent_turn_id.as_str())
    })?;
    let preceding_user = messages[..parent_index]
        .iter()
        .rev()
        .find(|message| message.role == MessageRecordRole::User)?;
    if preceding_user.id != relation.anchor_message_id {
        return None;
    }
    let parent = &messages[parent_index];
    (!parent.id.is_empty() && parent.chat_id.as_deref() == Some(session_id)).then_some(parent)
}

/// `anchoredStewardProgressByMessageId` for one message: the one child that is anchored to it;
/// two children on one parent leave neither attached.
pub(super) fn anchored_progress<'a>(
    message: &MessageRecord,
    view: &'a SessionView,
) -> Option<Anchored<'a>> {
    let mut owned = view.steward_children.iter().flatten().filter(|child| {
        anchored_parent(&view.messages, &view.session_id, child)
            .is_some_and(|parent| parent.id == message.id)
            && (child.active_turn.is_some() || child.latest_turn.is_some())
    });
    let child = owned.next()?;
    if owned.next().is_some() {
        return None;
    }
    let turn = child.active_turn.as_ref().or(child.latest_turn.as_ref())?;
    Some(Anchored {
        child,
        turn,
        rows: turn
            .progress
            .as_ref()
            .map_or(&[][..], |progress| progress.safe_progress_rows.as_slice()),
    })
}

/// `effectiveStewardStatus`: a terminal child (durable result) is done whatever its status says.
pub(super) fn effective_steward_status(child: &StewardSessionSummaryView) -> &'static str {
    match &child.status {
        SessionViewStatus::Delivered => "delivered",
        SessionViewStatus::Failed => "failed",
        SessionViewStatus::Cancelled => "cancelled",
        status if !child.terminal => match status {
            SessionViewStatus::Idle => "idle",
            SessionViewStatus::Active => "active",
            _ => "unknown",
        },
        _ => match child.result.as_ref().map(|result| &result.status) {
            Some(StewardResultViewStatus::Cancelled) => "cancelled",
            Some(StewardResultViewStatus::Blocked | StewardResultViewStatus::Failed) => "failed",
            _ => "delivered",
        },
    }
}

/// `stewardPlanProgress`: the step the child is on, as `n/total`.
fn plan_progress(child: &StewardSessionSummaryView) -> Option<String> {
    let (total, completed) = (child.approved_plan_total?, child.approved_plan_completed?);
    if total < 1 {
        return None;
    }
    let bounded = completed.max(0).min(total);
    Some(format!("{}/{total}", (bounded + 1).min(total)))
}

/// `stewardProgressStatus`.
fn progress_status(lang: Lang, child: &StewardSessionSummaryView) -> String {
    let copy = copy(lang);
    match effective_steward_status(child) {
        "delivered" => copy.delivered.to_string(),
        "failed" => copy.failed_past.to_string(),
        "cancelled" => copy.cancelled.to_string(),
        "idle" => copy.idle.to_string(),
        _ => match plan_progress(child) {
            Some(progress) => format!("{} · {progress}", copy.working),
            None => copy.working.to_string(),
        },
    }
}

/// `stewardStepProgressStatus`: accepted plans add step detail to the card's fallback.
pub(super) fn step_progress_status(
    lang: Lang,
    child: &StewardSessionSummaryView,
    narrow: bool,
) -> String {
    let Some(plan) = &child.plan else {
        return progress_status(lang, child);
    };
    let status = effective_steward_status(child);
    let mut actions: Vec<_> = plan.actions.iter().collect();
    actions.sort_by_key(|action| action.order);
    let done = actions
        .iter()
        .filter(|action| action.status == WorkPlanActionStatus::Done)
        .count();
    let with_status =
        |wanted: WorkPlanActionStatus| actions.iter().find(|action| action.status == wanted);
    match status {
        "delivered" => return plan_delivered(lang, done, actions.len()),
        "failed" => {
            let step = with_status(WorkPlanActionStatus::Blocked)
                .or_else(|| with_status(WorkPlanActionStatus::Active))
                .map_or("", |action| action.title.as_str());
            return plan_failed(lang, step);
        }
        "idle" | "cancelled" => return progress_status(lang, child),
        _ => {}
    }
    let active: Vec<&str> = actions
        .iter()
        .filter(|action| action.status == WorkPlanActionStatus::Active)
        .map(|action| action.title.as_str())
        .collect();
    match active.first() {
        Some(first) if narrow && active.len() >= 2 => plan_compact(lang, first, active.len() - 1),
        _ => plan_running(lang, done, actions.len(), &active.join(", ")),
    }
}

fn is_generic_model_round(row: &ProgressRow) -> bool {
    row.bridge_phase.as_deref() == Some("model_round_waiting")
        || row.safe_tool_name.as_deref() == Some("model_round")
}

fn is_model_authored_phase(row: &ProgressRow) -> bool {
    row.work_decision_source.as_deref() == Some("model-authored")
}

/// `stewardCurrentActivityTitle`.
pub(super) fn current_activity_title(lang: Lang, child: &StewardSessionSummaryView) -> String {
    let copy = copy(lang);
    if child.waiting_for_children == Some(true) && child.active_turn.is_none() {
        return copy.pending_waiting_for_children.to_string();
    }
    let progress = child
        .active_turn
        .as_ref()
        .and_then(|turn| turn.progress.as_ref());
    let rows = progress.map_or(&[][..], |progress| progress.safe_progress_rows.as_slice());
    let labelled = |row: &ProgressRow| !row.safe_label.trim().is_empty();
    let activity = |row: &ProgressRow| {
        row.kind.as_deref() != Some("todo")
            && row.kind.as_deref() != Some("turn")
            && !is_generic_model_round(row)
            && !is_model_authored_phase(row)
            && labelled(row)
    };
    let latest =
        |matches: &dyn Fn(&ProgressRow) -> bool| rows.iter().rev().find(|row| matches(row));
    let active_activity = latest(&|row: &ProgressRow| {
        activity(row) && matches!(row.state.as_str(), "running" | "thinking")
    });
    let latest_activity = latest(&|row: &ProgressRow| activity(row));
    let active_plan_step = rows.iter().find(|row| {
        row.kind.as_deref() == Some("todo")
            && matches!(row.state.as_str(), "active" | "running")
            && labelled(row)
    });
    let generic = latest(&|row: &ProgressRow| {
        row.kind.as_deref() != Some("todo") && is_generic_model_round(row) && labelled(row)
    });
    let label_of = |row: Option<&ProgressRow>| {
        row.map(|row| interface_progress_label(lang, row))
            .filter(|label| !label.is_empty())
    };
    let summary = progress
        .and_then(|progress| {
            progress
                .summary_reference
                .as_ref()
                .map(|reference| interface_text(lang, reference))
                .or_else(|| progress.summary.clone())
        })
        .filter(|summary| !summary.is_empty());
    let title = label_of(active_activity)
        .or_else(|| label_of(latest_activity))
        .or_else(|| label_of(active_plan_step))
        .or_else(|| label_of(generic))
        .or(summary)
        .unwrap_or_else(|| copy.progress.to_string());
    title.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A snake_case identifier (`^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$`).
fn is_identifier_like(value: &str) -> bool {
    let mut parts = value.split('_');
    let word = |part: &str| {
        part.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    };
    let first = parts.next().unwrap_or("");
    let rest: Vec<&str> = parts.collect();
    first.starts_with(|c: char| c.is_ascii_lowercase())
        && word(first)
        && !rest.is_empty()
        && rest.iter().all(|part| !part.is_empty() && word(part))
}

fn is_useful_worker_title(lang: Lang, value: &str) -> bool {
    let copy = copy(lang);
    let normalized = value.trim().to_lowercase();
    let generic = [
        copy.progress,
        tool_fallback(lang),
        copy.worker_activity,
        "작업 중",
        "도구 사용",
        "도구 사용 내역",
        "tool use",
        "tool usage",
        "use tool",
        "working",
        "native child work",
    ];
    !normalized.is_empty()
        && !generic
            .iter()
            .any(|label| normalized == label.trim().to_lowercase())
        && !is_identifier_like(&normalized)
}

/// `workerActivityTitle`.
pub(super) fn worker_activity_title(lang: Lang, current: &str, task_title: &str) -> String {
    let current = current.trim();
    if is_useful_worker_title(lang, current) {
        return current.to_string();
    }
    let title = task_title.trim();
    if is_useful_worker_title(lang, title) {
        title.to_string()
    } else {
        copy(lang).worker_activity.to_string()
    }
}

/// `toolchainGroupLabel`: the kind of a work step.
fn group_label(lang: Lang, row: &ProgressRow) -> String {
    let copy = copy(lang);
    let tool = row.safe_tool_name.as_deref().map(str::trim);
    let public_tool = || {
        let name = tool.unwrap_or("");
        if ["Bun", "Bash", "Web search", "Read", "Edit", "Write"].contains(&name) {
            return name.to_string();
        }
        tool_title(lang, name)
    };
    if tool == Some("ask_user") {
        return public_operation_title(lang, Some("ask_user"));
    }
    if tool == Some("delegate_to_worker") {
        return copy.worker_call.to_string();
    }
    if row.bridge_phase.as_deref() == Some("btcc_operation") {
        return match tool {
            Some("web_search") => copy.search.to_string(),
            Some("web_read" | "browser_read" | "read_file" | "list_files" | "grep_files") => {
                copy.lookup.to_string()
            }
            Some("edit_file" | "write_file") => copy.edit.to_string(),
            Some("run_command") => copy.command.to_string(),
            _ => public_tool(),
        };
    }
    let kind = row.kind.as_deref();
    if kind == Some("searched") || tool == Some("Web search") {
        return copy.search.to_string();
    }
    match (tool, kind) {
        (Some("Bash"), _) => "Bash".to_string(),
        (_, Some("ran_command")) => copy.command.to_string(),
        (_, Some("read")) => copy.read.to_string(),
        (_, Some("edited")) => copy.edit.to_string(),
        (Some(name), _) if !name.is_empty() => public_tool(),
        (_, Some("dispatch")) => tool_fallback(lang).to_string(),
        _ => copy.review.to_string(),
    }
}

/// `workBlockLatestStatus`: only the latest activity and the kind of its latest step; once
/// settled, that activity and how the run ended.
pub(super) fn latest_status(
    lang: Lang,
    rows: &[ProgressRow],
    turn_id: &str,
    live: bool,
    settled_state: &str,
) -> Option<String> {
    let projection = project_turn_activity(lang, rows, Some(turn_id));
    let latest = projection.phase_activities.last()?;
    let kind = if live {
        match latest.operations.last() {
            Some(step) => group_label(lang, step),
            None => phase_label(lang, latest.phase.as_deref()).to_string(),
        }
    } else {
        phase_label(lang, Some(settled_state)).to_string()
    };
    let parts = [display_title(latest, lang), kind];
    Some(
        parts
            .iter()
            .filter(|part| !part.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join(" · "),
    )
}

/// `workBlockTail`: the title of the activity before the latest one, and how many records the
/// expanded timeline holds beyond the latest.
pub(super) fn tail(lang: Lang, rows: &[ProgressRow], turn_id: &str) -> (Option<String>, usize) {
    let projection = project_turn_activity(lang, rows, Some(turn_id));
    let activities = &projection.phase_activities;
    let previous = activities
        .len()
        .checked_sub(2)
        .map(|at| display_title(&activities[at], lang));
    (previous, activities.len().saturating_sub(1))
}
