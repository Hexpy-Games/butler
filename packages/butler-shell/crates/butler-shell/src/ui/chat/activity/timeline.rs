//! `TurnActivityTimeline`, `TurnActivityPanel`, `TurnActivityBlock`, `TurnActivityPending`.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::work_activity::WorkActivityBlock;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::collapsible::Collapsible;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::icon_px;
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::rolling_swap::RollingSwap;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window, div, px};

use super::blocks::{locale, tool_items};
use super::project::{PhaseActivity, phase_label, project};
use super::status::current_turn_status;
use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::ProgressRow;

/// The activity timeline of one turn.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(crate) fn timeline(
    rows: &[ProgressRow],
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let turn_id = rows.iter().find_map(|row| row.turn_id.clone());
    let live = t
        .view
        .active_turn
        .as_ref()
        .is_some_and(|turn| Some(&turn.id) == turn_id.as_ref());
    timeline_with(rows, turn_id.as_deref(), None, live, window, cx)
        .unwrap_or_else(|| div().into_any_element())
}

/// `TurnActivityTimeline` for the phase activities of `rows`; `None` when there are none.
/// `state` is the turn's current state (`currentState`).
pub(super) fn timeline_with(
    rows: &[ProgressRow],
    turn_id: Option<&str>,
    state: Option<&str>,
    live: bool,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let lang = Ds::get(cx).lang();
    let projection = project(rows, turn_id, lang);
    let activities = projection.phase_activities;
    let latest = activities.last()?.clone();
    let state = state.map(str::to_string).or(projection.semantic_state);
    let key = format!("turn-activity-{}", activities[0].id);
    let open = window.use_keyed_state(format!("{key}-expanded"), cx, |_, _| false);
    let expanded = *open.read(cx);
    let current = phase_label(lang, state.as_deref().or(latest.phase.as_deref()));
    let header_label = locale(cx)
        .strings()
        .activity_history(live, current, activities.len());
    let set = |value: Option<bool>| {
        let open = open.clone();
        move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| {
            open.update(cx, |open, cx| {
                *open = value.unwrap_or(!*open);
                cx.notify();
            });
        }
    };
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
        body = body.child(
            Stack::new()
                .gap(Space::Sm)
                .children(activities.iter().enumerate().map(|(index, activity)| {
                    activity_block(activity, index < last, false, lang).into_any_element()
                })),
        );
        let collapse = if lang == Lang::Ko {
            "접기"
        } else {
            "Collapse"
        };
        body = body.child(
            Stack::new().cross(Cross::Start).child(
                Button::new(format!("{key}-collapse"))
                    .variant(Variant::Borderless)
                    .size(Size::Xs)
                    .icon_start(icon_px(Icon::ListChecks, px(14.)))
                    .text(collapse)
                    .on_click(set(Some(false))),
            ),
        );
    } else {
        // The current step folds away with its spacing when the turn settles; the header stays.
        let item_key: SharedString = latest.id.clone().into();
        let step = RollingSwap::new(format!("{key}-swap"), item_key, move |_, cx| {
            activity_block(&latest, false, false, Ds::get(cx).lang()).into_any_element()
        })
        .motion(live);
        body = body.child(Collapsible::new(format!("{key}-step"), live).child(step));
    }
    Some(
        Stack::new()
            .gap(Space::Xs)
            .child(header)
            .child(body)
            .into_any_element(),
    )
}

/// `ActivityBlock` of TurnActivityBlock.tsx: a compact work activity with its operations.
fn activity_block(
    activity: &PhaseActivity,
    connected: bool,
    live: bool,
    lang: Lang,
) -> WorkActivityBlock {
    let (content, intent, next) = if lang == Lang::Ko {
        ("내용:", "의도:", "다음:")
    } else {
        ("Content:", "Intent:", "Next:")
    };
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
    .description(lines.join("\n"))
    .tools(tool_items(&activity.operations, lang));
    if connected {
        block = block.connected();
    }
    if live {
        block = block.live();
    }
    block
}

/// `activityDisplayTitle`: the raw request echo reads as "Check request".
fn display_title(activity: &PhaseActivity, lang: Lang) -> String {
    if has_request_marker(&activity.title) {
        start_work(lang).to_string()
    } else {
        activity.title.clone()
    }
}

fn start_work(lang: Lang) -> &'static str {
    if lang == Lang::Ko {
        "요청 내용 확인"
    } else {
        "Check request"
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
    let title = if has_request_marker(&activity.title) {
        start_work(lang).to_string()
    } else {
        activity.title.clone()
    };
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

/// `formatActivityTime`: `HH:MM:SS` of the timestamp, the timestamp itself when it is not one.
fn activity_time(value: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(value).map_or_else(
        |_| value.to_string(),
        |at| at.format("%H:%M:%S").to_string(),
    )
}

/// `TurnActivityPanel`: the running turn's timeline above its live status line.
#[allow(
    dead_code,
    reason = "wired by Opus at wave integration (live turn row)"
)]
pub(crate) fn turn_activity_panel(
    rows: &[ProgressRow],
    turn_id: Option<&str>,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let work = timeline_with(rows, turn_id, None, true, window, cx);
    let status = current_turn_status(t, window, cx);
    Stack::new()
        .gap(Space::Md)
        .children(work)
        .children(status)
        .into_any_element()
}
