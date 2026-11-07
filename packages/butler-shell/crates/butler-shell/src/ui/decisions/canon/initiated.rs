//! `InitiatedPanels` (the pattern proposal and the schedule pause), `InitiatedApprovalLine` and
//! `TurnDecisionRow`; the canon panels are in the parent.
use butler_ds::tokens::Length;
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::composer_decision_panel::{Action, ComposerDecisionPanel, Detail};
use butler_ds::ui::blocks::composer_panel::Placement;
use butler_ds::ui::button::Variant;
use butler_ds::ui::clickable::{Clickable, Variant as ClickVariant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::tag::Tag;
use butler_ds::ui::typo::{Tone, Typo, Weight, Wrap};
use butler_shell_client::Error;
use gpui::{
    AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Styled as _, Window, div,
};
use serde_json::{Value, json};

use super::{call, hooks, panel_state, run_decision};
use crate::ui::i18n::initiated::Initiated;
use crate::ui::source::wire::{
    InitiatedOrigin, InitiatedOriginPanel, InitiatedOriginPanelSchedulePauseState,
    InitiatedSchedule, InitiatedScheduleType, PatternCandidate, PatternCandidateEvidence,
    PatternCandidateState,
};

/// `InitiatedPanels`
pub(super) fn initiated_panels(
    origin: Option<&InitiatedOrigin>,
    window: &mut Window,
    cx: &mut App,
) -> Vec<AnyElement> {
    match origin.and_then(|origin| origin.panel.as_ref()) {
        Some(InitiatedOriginPanel::PatternProposal {
            bundle_id,
            candidates,
        }) => candidates
            .iter()
            .map(|candidate| proposal(bundle_id, candidate, window, cx))
            .collect(),
        Some(InitiatedOriginPanel::SchedulePause {
            automation_id,
            state,
            title,
            schedule,
            unopened_count,
        }) => vec![pause(
            (automation_id, title, schedule, *unopened_count),
            state,
            window,
            cx,
        )],
        Some(panel) => super::canon_panel(panel, window, cx).into_iter().collect(),
        None => Vec::new(),
    }
}

/// `openSchedule`
fn open_schedule(id: Option<&str>, cx: &mut App) {
    match id {
        Some(id) => call(|hooks| &hooks.open_automation, id, cx),
        None => {
            if let Some(open) = hooks(cx).open_memory_settings {
                open(cx);
            }
        }
    }
}

/// `DecisionActions`: the two buttons of a suggestion.
fn decision_actions(
    panel: ComposerDecisionPanel,
    copy: &Initiated,
    decide: impl Fn(bool, &mut Window, &mut App) + Clone + 'static,
) -> ComposerDecisionPanel {
    let no = decide.clone();
    panel
        .action(Action::new(
            copy.no_thanks,
            Variant::Secondary,
            move |window, cx| {
                no(false, window, cx);
            },
        ))
        .action(Action::new(
            copy.sounds_good,
            Variant::Default,
            move |window, cx| {
                decide(true, window, cx);
            },
        ))
}

/// `Proposal`. The start date of the action line (`initiatedAction` with a time zone and the
/// automation's next run) is left out.
fn proposal(
    bundle_id: &str,
    candidate: &PatternCandidate,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let copy = Initiated::get(cx);
    let id = SharedString::from(format!(
        "initiated-proposal-{bundle_id}-{}",
        candidate.pattern_id
    ));
    let state = panel_state(&id, window, cx);
    let pending = candidate.state == PatternCandidateState::Pending;
    let action = initiated_action(copy, &candidate.action.title, &candidate.action.schedule);
    if !pending {
        let accepted = candidate.state == PatternCandidateState::Accepted;
        let text = if accepted {
            (copy.created)(&action)
        } else {
            (copy.skipped)(&action)
        };
        let automation = candidate.automation_id.clone().filter(|_| accepted);
        return settled_suggestion(&id, text, automation);
    }
    let (bundle, pattern) = (bundle_id.to_owned(), candidate.pattern_id.clone());
    let decide = move |accept: bool, window: &mut Window, cx: &mut App| {
        let (bundle, pattern) = (bundle.clone(), pattern.clone());
        run_decision(
            &state,
            Some("general".to_owned()),
            move |client| async move {
                let view = client.list_memory_pattern_proposals().await?;
                let revision = view
                    .get("revision")
                    .and_then(Value::as_i64)
                    .ok_or(Error::Protocol)?;
                let body = json!({
                    "pattern_id": pattern,
                    "decision": if accept { "accepted" } else { "declined" },
                    "expected_revision": revision,
                });
                client
                    .resolve_memory_pattern_proposal(&bundle, &body)
                    .await
                    .map(|_| ())
            },
            |_| {},
            window,
            cx,
        );
    };
    let details = [
        Detail::line(candidate.title.clone()),
        Detail::line(pattern_meta(copy, &candidate.evidence)),
    ];
    let panel =
        ComposerDecisionPanel::new(id, Icon::Clock3, action, |_, _, cx| open_schedule(None, cx))
            .placement(Placement::Conversation)
            .details(details);
    decision_actions(panel, copy, decide).into_any_element()
}

/// `Pause`
fn pause(
    (automation_id, title, schedule, unopened): (&str, &str, &InitiatedSchedule, i64),
    server: &InitiatedOriginPanelSchedulePauseState,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let copy = Initiated::get(cx);
    let id = SharedString::from(format!("initiated-pause-{automation_id}"));
    let state = panel_state(&id, window, cx);
    let pending = *server == InitiatedOriginPanelSchedulePauseState::Pending;
    let action = initiated_action(copy, title, schedule);
    if !pending {
        let continued = *server == InitiatedOriginPanelSchedulePauseState::Continued;
        let text = if continued {
            (copy.continuing)(&action)
        } else {
            (copy.paused)(&action)
        };
        return settled_suggestion(&id, text, Some(automation_id.to_owned()));
    }
    let automation = automation_id.to_owned();
    let decide = {
        let automation = automation.clone();
        move |accept: bool, window: &mut Window, cx: &mut App| {
            let automation = automation.clone();
            run_decision(
                &state,
                None,
                move |client| async move {
                    let body = json!({ "decision": if accept { "continue" } else { "stop" } });
                    client
                        .decide_report_pause(&automation, &body)
                        .await
                        .map(|_| ())
                },
                |_| {},
                window,
                cx,
            );
        }
    };
    let panel = ComposerDecisionPanel::new(id, Icon::Clock3, action, move |_, _, cx| {
        open_schedule(Some(&automation), cx);
    })
    .placement(Placement::Conversation)
    .details([Detail::line((copy.unopened)(unopened))]);
    decision_actions(panel, copy, decide).into_any_element()
}

/// `SettledSuggestion`
fn settled_suggestion(id: &SharedString, text: String, automation: Option<String>) -> AnyElement {
    let caption = Typo::caption(text)
        .tone(Tone::Secondary)
        .wrap(Wrap::Anywhere);
    match automation {
        Some(automation) => Clickable::new(SharedString::from(format!("{id}-resolution")))
            .variant(ClickVariant::Text)
            .on_click(move |_, _, cx| open_schedule(Some(&automation), cx))
            .child(caption)
            .into_any_element(),
        None => caption.into_any_element(),
    }
}

/// `initiatedFrequency`: local clock fields, no second time zone conversion.
fn frequency(copy: &Initiated, schedule: &InitiatedSchedule) -> String {
    let clock = schedule.time.as_deref().unwrap_or("00:00");
    let (hour, minute) = clock.split_once(':').unwrap_or((clock, "0"));
    let time = (copy.time)(hour.parse().unwrap_or(0), minute.parse().unwrap_or(0));
    match schedule.r#type {
        InitiatedScheduleType::Daily => (copy.daily_at)(&time),
        InitiatedScheduleType::Weekdays => (copy.weekdays_at)(&time),
        InitiatedScheduleType::Weekly => {
            let days: Vec<&str> = schedule
                .weekdays
                .iter()
                .flatten()
                .map(|day| {
                    copy.weekdays[usize::try_from((day - 1).rem_euclid(7)).unwrap_or_default()]
                })
                .collect();
            (copy.weekly_at)(&days.join(", "), &time)
        }
        InitiatedScheduleType::Interval => copy.interval.to_owned(),
        _ => copy.once.to_owned(),
    }
}

/// `initiatedAction` without the start date.
fn initiated_action(copy: &Initiated, title: &str, schedule: &InitiatedSchedule) -> String {
    (copy.action)(&frequency(copy, schedule), title)
}

/// `patternMeta`: how long and how often a pattern was seen.
fn pattern_meta(copy: &Initiated, evidence: &PatternCandidateEvidence) -> String {
    let now = chrono::Utc::now().timestamp();
    let first = chrono::DateTime::parse_from_rfc3339(&evidence.first_at)
        .map_or(now, |time| time.timestamp());
    let days = ((now - first).max(0) + 86_399).div_euclid(86_400).max(1);
    let weeks = days / 7;
    let span = if days < 14 {
        (copy.pattern_days)(days)
    } else if weeks < 9 {
        (copy.pattern_weeks)(weeks)
    } else {
        (copy.pattern_months)((days / 30).max(1))
    };
    format!("{span} · {}", (copy.pattern_count)(evidence.count))
}

/// The label and target of an initiated approval (`approvalActionView` of the normalized
/// `origin.approval`); W2's approval view produces them.
pub(crate) struct ApprovalLineText {
    pub(crate) label: String,
    pub(crate) target: String,
}

/// `InitiatedApprovalLine`; `approval` is `None` when `origin.approval` does not normalize.
pub(crate) fn initiated_approval_line(
    origin: &InitiatedOrigin,
    approval: Option<ApprovalLineText>,
    cx: &App,
) -> Option<AnyElement> {
    let approval = approval?;
    let copy = Initiated::get(cx);
    let ds = Ds::get(cx);
    let first = origin
        .label
        .clone()
        .filter(|label| !label.is_empty())
        .unwrap_or(approval.label);
    let text = [
        Some(first),
        Some(approval.target),
        origin.automation_title.clone(),
    ]
    .into_iter()
    .flatten()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" · ");
    let (observer, automation) = (origin.work_session_id.clone(), origin.automation_id.clone());
    let id = SharedString::from(format!(
        "initiated-approval-{}",
        origin.relation_id.as_deref().unwrap_or_default()
    ));
    Some(
        Clickable::new(id.clone())
            .variant(ClickVariant::Text)
            .on_click(move |_, _, cx| {
                if let Some(session) = &observer {
                    call(|hooks| &hooks.open_observer, session, cx);
                } else if let Some(automation) = &automation {
                    call(|hooks| &hooks.open_automation, automation, cx);
                }
            })
            .child(
                div()
                    .flex()
                    .items_start()
                    .gap(ds.len(Length::SpaceXs))
                    .child(div().flex_none().child(Tag::new(
                        SharedString::from(format!("{id}-tag")),
                        copy.needs_approval,
                    )))
                    .child(div().min_w_0().child(Typo::body(text).wrap(Wrap::Anywhere))),
            )
            .into_any_element(),
    )
}

/// `TurnDecisionRow`: the assistant's decision summary with its rationale and next step.
pub(crate) fn turn_decision_row(
    summary: &str,
    rationale: Option<&str>,
    next_step: Option<&str>,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let details = [rationale, next_step]
        .into_iter()
        .flatten()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            Typo::body(line.to_owned())
                .tone(Tone::Secondary)
                .weight(Weight::Regular)
                .wrap(Wrap::Anywhere)
        });
    div()
        .pl(ds.len(Length::Space2xl))
        .flex()
        .flex_col()
        .gap(ds.len(Length::SpaceXs))
        .child(
            Typo::body(summary.to_owned())
                .tone(Tone::Primary)
                .weight(Weight::Medium)
                .wrap(Wrap::Anywhere),
        )
        .children(details)
        .into_any_element()
}
