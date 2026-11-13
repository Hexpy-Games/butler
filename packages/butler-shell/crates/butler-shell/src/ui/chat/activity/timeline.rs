//! `TurnActivityTimeline`, `TurnActivityPanel`, `TurnActivityBlock`, `TurnActivityPending`.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::work_activity::WorkActivityBlock;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::collapsible::Collapsible;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::icon_px;
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::rolling_swap::RollingSwap;
use gpui::{
    AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Styled as _,
    Window, div, px,
};

use super::blocks::{content_x, locale, locale_of, work_blocks};
use super::is_general_chat;
use super::status::current_turn_status;
use super::tools::{is_browser_step, tool_column};
use crate::ui::chat::TranscriptCtx;
use crate::ui::decisions::{browser_step_still, turn_decision_row};
use crate::ui::source::wire::ProgressRow;
use crate::ui::store::progress::activity::{
    ActivityReadModel, PhaseActivity, TurnActivityProjection, project_turn_activity,
};
use crate::ui::store::progress::copy::copy;
use crate::ui::store::progress::labels::phase_label;

/// `TurnActivityTimeline` for the phase activities of `rows`; `None` when there are none.
/// `state` is the turn's current state (`currentState`).
pub(super) fn timeline(
    rows: &[ProgressRow],
    turn_id: Option<&str>,
    state: Option<&str>,
    live: bool,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let lang = Ds::get(cx).lang();
    let projection = project_turn_activity(lang, rows, turn_id);
    let activities = projection.phase_activities;
    let latest = activities.last()?.clone();
    let state = state.map(str::to_string).or(projection.semantic_state);
    let key = format!("turn-activity-{}", activities[0].id);
    let open = window.use_keyed_state(format!("{key}-expanded"), cx, |_, _| false);
    let expanded = *open.read(cx);
    let current = phase_label(lang, state.as_deref().or(latest.phase.as_deref()));
    let strings = locale(cx).strings();
    let header_label = strings.activity_history(live, current, activities.len());
    let set = |value: Option<bool>| toggle_open(open.clone(), value);
    let chevron = if expanded {
        Icon::ChevronDown
    } else {
        Icon::ChevronRight
    };
    let header = Stack::new().cross(Cross::Start).child(
        Button::new(format!("{key}-toggle"))
            .variant(Variant::Inline)
            .text(header_label)
            .icon_end(icon_px(chevron, px(14.)))
            .on_click(set(None)),
    );
    let mut body = Stack::new().gap(Space::Sm);
    if expanded {
        let last = activities.len() - 1;
        let views: Vec<AnyElement> = activities
            .iter()
            .enumerate()
            .map(|(index, activity)| activity_view(activity, index < last, t, window, cx))
            .collect();
        body = body.child(Stack::new().gap(Space::Sm).children(views));
        body = body.child(
            Stack::new().cross(Cross::Start).child(
                Button::new(format!("{key}-collapse"))
                    .variant(Variant::Borderless)
                    .size(Size::Xs)
                    .icon_start(icon_px(Icon::ListChecks, px(14.)))
                    .text(strings.activity_collapse())
                    .on_click(set(Some(false))),
            ),
        );
    } else if let Some(step) = collapsed_step(&activities, &key, turn_id, live, t, window, cx) {
        body = body.child(step);
    }
    Some(
        Stack::new()
            .gap(Space::Xs)
            .child(header)
            .child(body)
            .into_any_element(),
    )
}

/// Sets or flips the timeline's expanded state.
fn toggle_open(
    open: Entity<bool>,
    value: Option<bool>,
) -> impl Fn(&gpui::ClickEvent, &mut Window, &mut App) {
    move |_, _, cx| {
        open.update(cx, |open, cx| {
            *open = value.unwrap_or(!*open);
            cx.notify();
        });
    }
}

/// The collapsed timeline: the latest browser page, then the current step.
fn collapsed_step(
    activities: &[PhaseActivity],
    key: &str,
    turn_id: Option<&str>,
    live: bool,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<Stack> {
    let latest = activities.last()?.clone();
    // The current step folds away with its spacing when the turn settles; the header stays.
    let item_key: SharedString = latest.id.clone().into();
    let tools = activity_tools(&latest, t, window, cx);
    let step = RollingSwap::new(format!("{key}-swap"), item_key, move |_, cx| {
        activity_block(&latest, false, false, Ds::get(cx).lang()).into_any_element()
    })
    .motion(live);
    let still =
        browser_timeline_still(activities, turn_id, live).and_then(|(turn, call, result)| {
            browser_step_still(&turn, &call, &result, None, window, cx)
        });
    let gap = still.is_some().then(|| div().h(Space::Sm.px(Ds::get(cx))));
    let step = Stack::new().gap(Space::Xs).child(step).children(tools);
    let step = Stack::new().gap(Space::None).children(gap).child(step);
    Some(
        Stack::new()
            .gap(Space::None)
            .children(still)
            .child(Collapsible::new(format!("{key}-step"), live).child(step)),
    )
}

/// `browserTimelineStill`: the latest browser page above a collapsed timeline, as (turn, call,
/// result) ids; `None` when the turn has none to show.
fn browser_timeline_still(
    activities: &[PhaseActivity],
    turn_id: Option<&str>,
    live: bool,
) -> Option<(String, String, String)> {
    let (index, activity) = activities
        .iter()
        .enumerate()
        .rev()
        .find(|(_, item)| item.operations.iter().any(is_browser_step))?;
    let at = activity.operations.iter().rposition(is_browser_step)?;
    let row = &activity.operations[at];
    let call = row.tool_call_id.as_deref().filter(|id| !id.is_empty())?;
    let result = row.tool_result_id.as_deref()?;
    let turn = turn_id.filter(|id| !id.is_empty())?;
    if live && index == activities.len() - 1 {
        return None;
    }
    // A later capture is the turn's picture and the reply shows it.
    let captured = activity.operations[at + 1..].iter().any(|item| {
        item.safe_tool_name.as_deref() == Some("browser_screenshot")
            && item
                .tool_result_id
                .as_deref()
                .is_some_and(|id| !id.is_empty())
    });
    (!captured).then(|| (turn.to_owned(), call.to_owned(), result.to_owned()))
}

/// `workActivityToolsFromRows` of a phase activity: its operations' tool rows.
pub(super) fn activity_tools(
    activity: &PhaseActivity,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    tool_column(&activity.operations, None, content_x(true), t, window, cx)
}

/// `ActivityBlock` of TurnActivityBlock.tsx: a compact work activity with its operations.
fn activity_view(
    activity: &PhaseActivity,
    connected: bool,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let lang = Ds::get(cx).lang();
    let tools = activity_tools(activity, t, window, cx);
    Stack::new()
        .gap(Space::Xs)
        .child(activity_block(activity, connected, false, lang))
        .children(tools)
        .into_any_element()
}

/// `ActivityBlock` of TurnActivityBlock.tsx without its toolchain.
pub(super) fn activity_block(
    activity: &PhaseActivity,
    connected: bool,
    live: bool,
    lang: Lang,
) -> WorkActivityBlock {
    let [content, intent, next] = locale_of(lang).strings().activity_detail_labels();
    let phase = phase_label(lang, activity.phase.as_deref());
    let meta = match activity.created_at.as_deref().map(activity_time) {
        Some(time) => format!("{phase} · {time}"),
        None => phase.to_string(),
    };
    let summary = delegated_request_goal(activity, lang);
    let mut lines = vec![meta];
    if normalize(&activity.title) != normalize(&summary) {
        lines.push(format!("{content} {summary}"));
    }
    if let Some(rationale) = activity.rationale.as_deref().filter(|r| !r.is_empty()) {
        lines.push(format!("{intent} {rationale}"));
    }
    if let Some(step) = activity.next_step.as_deref().filter(|s| !s.is_empty()) {
        lines.push(format!("{next} {step}"));
    }
    let mut block = WorkActivityBlock::new(
        format!("activity-{}", activity.id),
        display_title(activity, lang),
    )
    .compact()
    .description(lines.join("\n"));
    if connected {
        block = block.connected();
    }
    if live {
        block = block.live();
    }
    block
}

/// `activityDisplayTitle`: the raw request echo reads as "Check request".
pub(super) fn display_title(activity: &PhaseActivity, lang: Lang) -> String {
    if has_request_marker(&activity.title) {
        copy(lang).start_work.to_string()
    } else {
        activity.title.clone()
    }
}

fn has_request_marker(text: &str) -> bool {
    request_marker_end(text).is_some()
}

/// The byte offset just after `사용자 요청:` or `User request:` (any case).
fn request_marker_end(text: &str) -> Option<usize> {
    let lower = text.to_ascii_lowercase();
    ["사용자 요청:", "user request:"]
        .iter()
        .find_map(|marker| lower.find(marker).map(|at| at + marker.len()))
}

fn normalize(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `delegatedRequestGoal` without a caller-supplied goal: the quoted original request.
fn delegated_request_goal(activity: &PhaseActivity, lang: Lang) -> String {
    let Some(end) = request_marker_end(&activity.summary) else {
        return activity.summary.clone();
    };
    let title = display_title(activity, lang);
    let request = quoted(activity.summary[end..].trim_start()).unwrap_or(&title);
    normalize(request)
}

/// The leading quoted segment: `'..'` and `".."` close before whitespace or the end; curly
/// quotes close at their pair.
fn quoted(text: &str) -> Option<&str> {
    let open = text.chars().next()?;
    let close = match open {
        '\'' | '"' => open,
        '\u{2018}' => '\u{2019}',
        '\u{201c}' => '\u{201d}',
        _ => return None,
    };
    let body = &text[open.len_utf8()..];
    let straight = open == close;
    let mut at = 0;
    while let Some(found) = body[at..].find(close) {
        let index = at + found;
        let after = &body[index + close.len_utf8()..];
        let boundary = !straight || after.is_empty() || after.starts_with(char::is_whitespace);
        if index > 0 && boundary {
            return Some(&body[..index]);
        }
        at = index + close.len_utf8();
    }
    None
}

/// `formatActivityTime`: `Intl.DateTimeFormat(undefined, {hour, minute, second: "2-digit"})`,
/// the local time in the OS locale; the timestamp itself when it is not one.
fn activity_time(value: &str) -> String {
    clock_time(value, true)
}

/// Shared local clock for `workPlanPresentation.ts` and `formatActivityTime`.
pub(super) fn clock_time(value: &str, seconds: bool) -> String {
    let Ok(at) = chrono::DateTime::parse_from_rfc3339(value) else {
        return value.to_string();
    };
    let at = at.with_timezone(&chrono::Local);
    let locale = sys_locale::get_locale().unwrap_or_default().to_lowercase();
    let format = if locale.starts_with("ko") {
        if seconds { "%p %I:%M:%S" } else { "%p %I:%M" }
    } else if locale.starts_with("en-us") || locale == "en" {
        if seconds { "%I:%M:%S %p" } else { "%I:%M %p" }
    } else {
        if seconds { "%H:%M:%S" } else { "%H:%M" }
    };
    let text = at.format(format).to_string();
    if locale.starts_with("ko") {
        text.replace("AM", "오전").replace("PM", "오후")
    } else {
        text
    }
}

/// `hasLiveWork`.
fn has_live_work(projection: &TurnActivityProjection) -> bool {
    projection.decisions().next().is_some()
        || !projection.work_blocks.is_empty()
        || !projection.phase_activities.is_empty()
        || projection.public_activity.is_some()
        || projection.model_round_wait.is_some()
        || projection.operation.is_some()
}

/// `liveTurnWork`: without a phase timeline, the work blocks, else the latest decision.
fn live_turn_work(
    projection: &TurnActivityProjection,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    if !projection.work_blocks.is_empty() {
        return work_blocks(&projection.work_blocks, true, t, window, cx);
    }
    if projection.public_activity.is_some()
        || projection.model_round_wait.is_some()
        || projection.operation.is_some()
    {
        return None;
    }
    match projection.decisions().last()? {
        ActivityReadModel::Decision {
            summary,
            rationale,
            next_step,
            ..
        } => Some(turn_decision_row(
            summary,
            rationale.as_deref(),
            next_step.as_deref(),
            cx,
        )),
        _ => None,
    }
}

/// `TurnActivityPanel`: the running turn's work above its live status line; the line alone
/// until work arrives and in the general chat.
pub(crate) fn turn_activity_panel(
    rows: &[ProgressRow],
    turn_id: Option<&str>,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let projection = project_turn_activity(Ds::get(cx).lang(), rows, turn_id);
    if is_general_chat(Some(&t.view.session_id)) || !has_live_work(&projection) {
        return current_turn_status(t, cx);
    }
    let work = match timeline(rows, turn_id, None, true, t, window, cx) {
        Some(timeline) => Some(timeline),
        None => live_turn_work(&projection, t, window, cx),
    };
    let status = current_turn_status(t, cx);
    Some(
        Stack::new()
            .gap(Space::Md)
            .children(work)
            .children(status)
            .into_any_element(),
    )
}
