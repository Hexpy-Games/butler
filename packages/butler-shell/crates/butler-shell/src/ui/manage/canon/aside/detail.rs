//! `EpicInspector.tsx`, `EpicDetail.tsx` and `EpicSessionSummary.tsx`: the epic's properties
//! (status, assignee, plan, tags), its task progress and the sections below them.
use gpui::{AppContext as _, Styled as _};
use std::rc::Rc;

use butler_ds::ui::blocks::key_value_row::{KeyValueRow, ValueSize};
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::blocks::progress_meter::ProgressMeter;
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::native_select::{NativeSelect, Size as SelectSize};
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::tooltip::Tooltip;
use butler_ds::ui::typo::{Tone, Typo, Wrap};
use gpui::{
    AnyElement, App, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, SharedString, Window, div,
};

use super::copy::STATUSES;
use super::inspector::EpicInspector;
use crate::ui::manage::canon::common::{
    LOCAL_PERSON_ID, OnSelect, OnTags, SelectOpts, TagsField, canon_avatar, person_name,
    person_select, plan_select,
};
use crate::ui::source::wire::{CanonPlan, CanonStatus, EpicDetail, EpicInput, Patch, PlanCards};
use crate::ui::widgets::anchor;

/// The tags field of the epic, kept across renders.
#[derive(Default)]
pub(super) struct TagsCache(Option<Entity<TagsField>>);

/// A write with one field set.
fn input(set: impl FnOnce(&mut EpicInput)) -> EpicInput {
    let mut input = EpicInput::default();
    set(&mut input);
    input
}

impl EpicInspector {
    /// A property's change: `build` makes the write and its toast from the picked value.
    fn property(
        cx: &mut Context<Self>,
        build: impl Fn(Option<SharedString>, &App) -> (EpicInput, Option<SharedString>) + 'static,
    ) -> OnSelect {
        let me = cx.weak_entity();
        Rc::new(
            move |value: Option<SharedString>, _: &mut Window, cx: &mut App| {
                let (write, message) = build(value, cx);
                let _ = me.update(cx, |this, cx| this.write(write, message, None, cx));
            },
        )
    }

    /// The status select. A running epic cannot be completed or cancelled.
    fn status_row(&self, epic: &EpicDetail, cx: &mut Context<Self>) -> KeyValueRow {
        let words = Self::words(cx);
        let running = self.tasks.as_ref().is_some_and(|tasks| tasks.running);
        let mut select = NativeSelect::new("canon-epic-status")
            .size(SelectSize::Sm)
            .value(
                STATUSES
                    .iter()
                    .position(|status| *status == epic.card.canon_status)
                    .map_or_else(String::new, |index| index.to_string()),
            );
        for (index, status) in STATUSES.iter().enumerate() {
            select = select.option(index.to_string(), words.status(*status));
        }
        if self.busy {
            select = select.disabled();
        }
        let me = cx.weak_entity();
        let select = select.on_change(move |picked, _, cx| {
            let Some(status) = picked
                .parse::<usize>()
                .ok()
                .and_then(|index| STATUSES.get(index))
                .copied()
            else {
                return;
            };
            let _ = me.update(cx, |this, cx| {
                let blocked = this.tasks.as_ref().is_some_and(|tasks| tasks.running)
                    && matches!(status, CanonStatus::Done | CanonStatus::Cancelled);
                if blocked {
                    // CARVE-OUT(G-ds): the DS select has no per-option disabled; React greys
                    // Done and Cancelled while running, here they are refused with the reason.
                    let running = Self::words(cx).running;
                    toast::show(cx, Toast::error(running));
                    return;
                }
                let status_input = input(|input| input.status = Some(status));
                let changed = Self::words(cx).status_changed;
                this.write(status_input, Some(changed.into()), None, cx);
            });
        });
        let tip = Tooltip::new("canon-epic-status-tip").wrap();
        let tip = if running {
            tip.label(format!("{} · {}", words.running, words.running_cancel))
        } else {
            tip
        };
        KeyValueRow::new(words.status, "")
            .value_size(ValueSize::Caption)
            .value_element(tip.child(select))
    }

    fn assignee_row(
        &self,
        epic: &EpicDetail,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> KeyValueRow {
        let words = Self::words(cx);
        let card = &epic.card;
        let on_change = Self::property(cx, |person, _| {
            let write = input(|input| {
                input.assignee = person.map_or(Patch::Clear, |p| Patch::Set(p.to_string()));
            });
            (write, None)
        });
        let select = person_select(
            "canon-epic-assignee",
            card.assignee.clone().map(SharedString::from),
            SelectOpts {
                disabled: self.busy,
                compact: true,
                stretch: false,
            },
            on_change,
            window,
            cx,
        );
        let working = card.agent.as_ref().map(|agent| {
            let who = if agent.person == LOCAL_PERSON_ID {
                person_name(cx).to_string()
            } else {
                agent.person.clone()
            };
            Typo::caption((words.working)(&who, &agent.via))
                .tone(Tone::Secondary)
                .wrap(Wrap::Anywhere)
        });
        let line = Stack::row()
            .gap(Space::Xs)
            .cross(Cross::Center)
            .children(canon_avatar(
                card.assignee.as_deref(),
                card.agent.as_ref(),
                cx,
            ))
            .child(div().min_w_0().child(select));
        KeyValueRow::new(words.assignee, "")
            .value_size(ValueSize::Caption)
            .value_element(
                Stack::new()
                    .gap(Space::Xs)
                    .cross(Cross::End)
                    .child(line)
                    .children(working),
            )
    }

    fn plan_row(
        &self,
        epic: &EpicDetail,
        plans: &[PlanCards],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> KeyValueRow {
        let words = Self::words(cx);
        let card = &epic.card;
        let ordinal = plans
            .iter()
            .find(|cards| Some(&cards.plan.id) == card.plan_id.as_ref())
            .and_then(|cards| cards.works.iter().position(|work| work.id == card.id))
            .map_or(0, |index| index + 1);
        let titles: Vec<CanonPlan> = plans.iter().map(|cards| cards.plan.clone()).collect();
        let moved = titles.clone();
        let on_plan = Self::property(cx, move |plan, cx| {
            let words = Self::words(cx);
            let title = plan
                .as_ref()
                .and_then(|id| moved.iter().find(|p| p.id == **id))
                .map_or(words.backlog, |p| p.title.as_str());
            let message = SharedString::from((words.moved)(title));
            let write = input(|input| {
                input.plan_id = plan.map_or(Patch::Clear, |p| Patch::Set(p.to_string()));
            });
            (write, Some(message))
        });
        let select = plan_select(
            "canon-epic-plan",
            &titles,
            card.plan_id.clone().map(SharedString::from),
            SelectOpts {
                disabled: self.busy,
                compact: true,
                stretch: false,
            },
            on_plan,
            window,
            cx,
        );
        let ordinal = (ordinal > 0)
            .then(|| Typo::caption(format!("· {}", (words.ordinal)(ordinal))).wrap(Wrap::Nowrap));
        KeyValueRow::new(words.plan, "")
            .value_size(ValueSize::Caption)
            .value_element(
                Stack::row()
                    .gap(Space::Xs)
                    .cross(Cross::Center)
                    .child(div().min_w_0().child(select))
                    .children(ordinal),
            )
    }

    fn tags_row(
        &mut self,
        epic: &EpicDetail,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> KeyValueRow {
        let words = Self::words(cx);
        let value: Vec<SharedString> = epic
            .card
            .tags
            .iter()
            .map(|tag| SharedString::from(tag.id.clone()))
            .collect();
        let field = match self.tags.0.clone() {
            Some(field) => field,
            None => {
                let me = cx.weak_entity();
                let on_change: OnTags = Rc::new(
                    move |ids: Vec<SharedString>, _: &mut Window, cx: &mut App| {
                        let tags = ids.iter().map(ToString::to_string).collect();
                        let _ = me.update(cx, |this, cx| {
                            this.write(input(|input| input.tags = Some(tags)), None, None, cx);
                        });
                    },
                );
                let (ctx, project) = (self.ctx.clone(), self.project.clone());
                let (initial, busy) = (value.clone(), self.busy);
                let field = cx.new(|cx| {
                    TagsField::new(&ctx, project, initial, on_change, busy, true, window, cx)
                });
                self.tags.0 = Some(field.clone());
                field
            }
        };
        let busy = self.busy;
        field.update(cx, |field, cx| {
            field.set_value(value, cx);
            field.set_disabled(busy, cx);
        });
        KeyValueRow::new(words.tags, "")
            .value_size(ValueSize::Caption)
            .value_element(field)
    }

    /// `EpicSessionSummary`: the shared task progress below the properties.
    fn session_summary(&self, epic: &EpicDetail, cx: &mut Context<Self>) -> AnyElement {
        let words = Self::words(cx);
        let (completed, total) = match (&self.tasks, &epic.card.task_counts) {
            (Some(tasks), _) => (tasks.counts.completed, tasks.counts.total),
            (None, Some(counts)) => (
                counts.statuses.get("completed").copied().unwrap_or(0),
                counts.total,
            ),
            (None, None) => (0, 0),
        };
        let small = |n: i64| u16::try_from(n).map_or(0., f32::from);
        let value = if total > 0 {
            small(completed) / small(total) * 100.
        } else {
            0.
        };
        let active = self
            .tasks
            .iter()
            .flat_map(|tasks| &tasks.actions)
            .filter(|action| action.status == "active")
            .map(|action| KeyValueRow::new(action.description.clone(), words.action_active));
        Stack::new()
            .gap(Space::Sm)
            .child(
                ProgressMeter::new("canon-epic-work", value)
                    .label(words.work)
                    .meta((words.done)(completed, total)),
            )
            .children(active)
            .into_any_element()
    }

    /// `EpicDetail`
    fn epic_detail(
        &mut self,
        epic: &EpicDetail,
        plans: &[PlanCards],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = Self::words(cx);
        let compact = self.embedded;
        let plan_title = plans
            .iter()
            .find(|cards| Some(&cards.plan.id) == epic.card.plan_id.as_ref())
            .map_or(words.backlog, |cards| cards.plan.title.as_str());
        let summary = Stack::row()
            .gap(Space::Xs)
            .cross(Cross::Center)
            .children(canon_avatar(
                epic.card.assignee.as_deref(),
                epic.card.agent.as_ref(),
                cx,
            ))
            .child(
                Typo::caption(format!(
                    "{} · {plan_title}",
                    words.status(epic.card.canon_status)
                ))
                .tone(Tone::Secondary),
            )
            .into_any_element();
        let menu = self.epic_menu(&epic.card, window, cx);
        let fields = self.inline_fields(epic, compact, menu, summary, window, cx);
        let properties = Stack::new()
            .gap(Space::Sm)
            .child(self.status_row(epic, cx))
            .child(self.assignee_row(epic, window, cx))
            .child(self.plan_row(epic, plans, window, cx))
            .child(self.tags_row(epic, window, cx));
        let conversation = epic
            .card
            .home_session_id
            .clone()
            .filter(|_| !self.embedded)
            .map(|session| {
                let ctx = self.ctx.clone();
                button::container(Size::Sm).child(
                    Button::new("canon-open-conversation")
                        .size(Size::Sm)
                        .variant(Variant::Outline)
                        .text(words.open_conversation)
                        .on_click(move |_, _, cx| ctx.open_session(session.clone().into(), cx)),
                )
            });
        let specs = self.spec_tree(&epic.specs, epic.card.criteria.as_ref(), compact, cx);
        anchor(div().id("epic-detail"), "epic-detail")
            .child(
                Stack::new()
                    .gap(Space::Lg)
                    .child(fields)
                    .child(properties)
                    .child(self.session_summary(epic, cx))
                    .children(conversation)
                    .child(specs)
                    .child(self.proposals(cx))
                    .child(self.activity_view(cx)),
            )
            .into_any_element()
    }
}

impl Render for EpicInspector {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let words = Self::words(cx);
        let ready = self.detail.clone().zip(self.plans.clone());
        let content: AnyElement = if self.missing {
            Typo::caption(words.missing).into_any_element()
        } else if let Some((epic, plans)) = ready {
            self.epic_detail(&epic, &plans, window, cx)
        } else if self.failed {
            let retry = Button::new("canon-epic-retry")
                .size(Size::Sm)
                .text(words.retry)
                .on_click(cx.listener(|this, _, _, cx| this.refresh(cx)));
            Notice::new(NoticeTone::Error, words.request_failed)
                .action(retry)
                .into_any_element()
        } else {
            ProgressMeter::indeterminate("canon-epic-loading")
                .label(words.loading)
                .into_any_element()
        };
        let card = self.detail.as_ref().map(|epic| epic.card.clone());
        let delete = card.and_then(|card| self.delete_dialog(&card, window, cx));
        let unsaved = self.unsaved_dialog(window, cx);
        div()
            .child(Stack::new().gap(Space::Sm).child(content))
            .children(delete)
            .children(unsaved)
    }
}
