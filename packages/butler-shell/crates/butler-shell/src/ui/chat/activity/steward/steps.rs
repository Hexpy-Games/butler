//! Inline plan details from `SessionObserverStepTimeline.tsx` and `WorkBlockDetails.tsx`.
use std::collections::{BTreeMap, HashSet};
use std::rc::Rc;

use butler_ds::ui::blocks::disclosure_row::{DisclosureRow, Surface};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::layout::{Box as DsBox, Space, Stack};
use butler_ds::ui::scroll::{MaxHeight, ScrollArea};
use butler_ds::ui::separator::Separator;
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window, div};

use super::super::child_views::{StepActivity, project};
use super::super::{status, timeline as activity, tools::worker::step_capsule};
use super::presentation::{plan_status_time, plan_time, revision_title};
use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::{
    SessionView, StewardSessionSummaryView, WorkPlan, WorkPlanAction, WorkPlanRevision,
};
use crate::ui::store::progress::activity::project_turn_activity;
use crate::ui::widgets::anchor;

/// `SessionObserverStepTimeline.tsx`: step order, unmatched activities and revision placement.
pub(super) fn timeline(
    view: &Rc<SessionView>,
    plan: &WorkPlan,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let lang = Ds::get(cx).lang();
    let activities = project(view, lang);
    let newest = activities.last();
    let mut actions: Vec<_> = plan.actions.iter().collect();
    actions.sort_by_key(|action| action.order);
    let groups = Groups::new(&actions, &activities);
    let mut child = t.clone();
    child.view = view;
    child.shared = view.clone();
    child.message_id = None;
    child.live_message = None;
    let line = window.use_keyed_state(
        SharedString::from(format!("plan-status:{}", view.session_id)),
        cx,
        |_, _| None,
    );
    line.update(cx, |line, cx| status::StatusLineView::sync(line, view, cx));
    child.status_line = line.read(cx).clone();
    let mut workers: BTreeMap<&str, Vec<&StewardSessionSummaryView>> = BTreeMap::new();
    for worker in &view.workers {
        if let Some(key) = worker
            .action_key
            .as_deref()
            .filter(|key| groups.keys.contains(key))
        {
            workers.entry(key).or_default().push(worker);
        }
    }
    let context = Steps {
        t: &child,
        newest,
        workers,
        live: view.active_turn.is_some(),
    };
    let body = context.body(plan, &actions, &groups, window, cx);
    ScrollArea::new(SharedString::from(format!(
        "plan-details:{}",
        view.session_id
    )))
    .max_height(MaxHeight::Sm)
    .child(DsBox::new().padding_x(Space::Md).child(body))
    .into_any_element()
}

struct Groups<'a> {
    keys: HashSet<&'a str>,
    before: Vec<&'a StepActivity>,
    after: Vec<&'a StepActivity>,
    steps: BTreeMap<&'a str, Vec<&'a StepActivity>>,
}

impl<'a> Groups<'a> {
    /// `SessionObserverStepTimeline.tsx`: split unmatched activities around the first start.
    fn new(actions: &[&'a WorkPlanAction], activities: &'a [StepActivity]) -> Self {
        let keys: HashSet<_> = actions.iter().map(|a| a.action_key.as_str()).collect();
        let first = actions.first().and_then(|a| a.started_at.as_deref());
        let mut before = Vec::new();
        let mut after = Vec::new();
        let mut grouped: BTreeMap<&str, Vec<&StepActivity>> = BTreeMap::new();
        for item in activities {
            if let Some(key) = item.action.as_deref().filter(|key| keys.contains(key)) {
                grouped.entry(key).or_default().push(item);
            } else if first
                .is_none_or(|start| item.phase.created_at.as_deref().unwrap_or("") < start)
            {
                before.push(item);
            } else {
                after.push(item);
            }
        }
        Self {
            keys,
            before,
            after,
            steps: grouped,
        }
    }
}

struct Steps<'a, 'v> {
    t: &'a TranscriptCtx<'v>,
    newest: Option<&'a StepActivity>,
    live: bool,
    workers: BTreeMap<&'a str, Vec<&'a StewardSessionSummaryView>>,
}

impl Steps<'_, '_> {
    /// `SessionObserverStepTimeline.tsx`: place revisions once beside their first added step.
    fn body(
        &self,
        plan: &WorkPlan,
        actions: &[&WorkPlanAction],
        groups: &Groups,
        window: &mut Window,
        cx: &mut App,
    ) -> Stack {
        let lang = Ds::get(cx).lang();
        let mut body =
            Stack::new()
                .gap(Space::Md)
                .child(self.activities(&groups.before, window, cx));
        let initial = plan
            .revisions
            .iter()
            .map(|r| r.revision)
            .chain(actions.iter().map(|a| a.added_in_revision))
            .min();
        let revisions: Vec<_> = plan
            .revisions
            .iter()
            .filter(|r| initial.is_some_and(|i| r.revision > i))
            .collect();
        let mut shown = HashSet::new();
        for action in actions {
            if let Some(revision) = revisions.iter().find(|r| {
                r.revision == action.added_in_revision
                    && r.added.contains(&action.action_key)
                    && !shown.contains(&r.revision)
            }) {
                shown.insert(revision.revision);
                body = body.child(revision_row(revision, lang));
            }
            body = body.child(
                self.step(
                    action,
                    groups
                        .steps
                        .get(action.action_key.as_str())
                        .map_or(&[], Vec::as_slice),
                    window,
                    cx,
                ),
            );
        }
        for revision in revisions.iter().filter(|r| !shown.contains(&r.revision)) {
            body = body.child(revision_row(revision, lang));
        }
        if !groups.after.is_empty() {
            body = body.child(Separator::new());
        }
        body = body
            .child(self.activities(&groups.after, window, cx))
            .children(self.footer(
                groups.before.is_empty() && groups.after.is_empty() && groups.steps.is_empty(),
                window,
                cx,
            ));
        body
    }

    /// `StepActivities`: all activities expanded, only the newest live activity pulses.
    fn activities(&self, rows: &[&StepActivity], window: &mut Window, cx: &mut App) -> AnyElement {
        let last = rows.len().saturating_sub(1);
        let elements: Vec<_> = rows
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let pulse = self.live
                    && self
                        .newest
                        .is_some_and(|latest| std::ptr::eq(latest, *item));
                let mut t = self.t.clone();
                t.message_id = None;
                let tools = activity::activity_tools(&item.phase, &t, window, cx);
                // The tool operations retain their own turn ids; source turn also scopes row identity.
                anchor(
                    div().child(
                        Stack::new()
                            .gap(Space::Xs)
                            .child(activity::activity_block(
                                &item.phase,
                                index < last,
                                pulse,
                                Ds::get(cx).lang(),
                            ))
                            .children(tools),
                    ),
                    &format!("plan-activity:{}:{}", item.turn, item.phase.id),
                )
                .into_any_element()
            })
            .collect();
        Stack::new()
            .gap(Space::Sm)
            .children(elements)
            .into_any_element()
    }

    /// `StepGroup`: keyed, initially open disclosure with a truncated purpose caption.
    fn step(
        &self,
        action: &WorkPlanAction,
        rows: &[&StepActivity],
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let id = gpui::ElementId::from(SharedString::from(format!(
            "plan-step:{}:{}",
            self.t.view.session_id, action.action_key
        )));
        let open = window.use_keyed_state((id.clone(), "open"), cx, |_, _| true);
        let expanded = *open.read(cx);
        let row = DisclosureRow::new(id.clone(), format!("{}. {}", action.order, action.title))
            .surface(Surface::Plain)
            .reveals()
            .open(expanded)
            .meta(plan_status_time(Ds::get(cx).lang(), action))
            .on_toggle(move |_, window, cx| {
                open.update(cx, |open, _| {
                    *open = !*open;
                });
                window.refresh();
            });
        let mut body = Stack::new().gap(Space::Sm).child(row).child(
            butler_ds::ui::tooltip::Tooltip::new((id, "purpose"))
                .label(action.purpose.clone())
                .fill()
                .child(Typo::caption(action.purpose.clone()).truncate()),
        );
        if expanded {
            body = body.child(self.activities(rows, window, cx));
            let workers: Vec<_> = self
                .workers
                .get(action.action_key.as_str())
                .into_iter()
                .flatten()
                .map(|worker| step_capsule(worker, cx))
                .collect();
            if !workers.is_empty() {
                body = body.child(anchor(
                    div().child(Stack::new().gap(Space::Xs).children(workers)),
                    "step-workers",
                ));
            }
        }
        body.into_any_element()
    }

    /// `SessionObserverCurrentStatus`: reuse the child's status and empty activity panel.
    fn footer(&self, empty: bool, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
        let active = self.t.view.active_turn.as_ref()?;
        let rows = active
            .progress
            .as_ref()
            .map_or(&[][..], |p| p.safe_progress_rows.as_slice());
        if empty
            && project_turn_activity(Ds::get(cx).lang(), rows, Some(&active.id))
                .phase_activities
                .is_empty()
        {
            activity::turn_activity_panel(rows, Some(&active.id), self.t, window, cx)
        } else {
            status::current_turn_status(self.t, cx)
        }
    }
}

/// `SessionObserverStepTimeline.tsx` RevisionRow is static and uses the shared plain row.
fn revision_row(revision: &WorkPlanRevision, lang: Lang) -> AnyElement {
    let mut row = DisclosureRow::new(
        SharedString::from(format!("plan-revision:{}", revision.revision)),
        revision_title(lang, revision.added.len(), revision.removed.len()),
    )
    .surface(Surface::Plain)
    .meta(plan_time(&revision.at));
    if let Some(reason) = revision.reason.clone().filter(|reason| !reason.is_empty()) {
        row = row.description(reason);
    }
    row.into_any_element()
}
