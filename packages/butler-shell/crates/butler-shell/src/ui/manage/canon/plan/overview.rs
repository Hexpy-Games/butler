//! `PlanOverview.tsx` and `usePlanOverview.ts`: one plan's (or the backlog's) epics in their
//! shared order, with the plan's progress.
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::dashboard_header::DashboardHeader;
use butler_ds::ui::blocks::management_page::{BackgroundTreatment, ManagementPage};
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::blocks::progress_meter::ProgressMeter;
use butler_ds::ui::button::{self, Button, Size};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::{Tone, Typo, Wrap};
use butler_shell_client::Error;
use gpui::{
    AnyView, App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, Styled as _, Window, div,
};
use serde_json::{Value, json};

use super::actions::{Act, OnAct};
use super::copy::words;
use super::create::EpicCreateDialog;
use super::delete::EpicDeleteDialog;
use super::feedback::write_failure;
use super::form::PlanFormDialog;
use super::list::{ListProps, epic_list};
use crate::ui::manage::{Action, ManageCtx, Topic, View, placeholder};
use crate::ui::source::fetch::{Flight, fetch, fetch_if};
use crate::ui::source::wire::{
    CanonOverview, CanonStatus, EpicCard, EpicDetail, EpicInput, PlanCards,
};
use crate::ui::widgets::anchor;

/// `PlanOverview`
pub(super) fn page(ctx: ManageCtx, cx: &mut App) -> AnyView {
    let View::PlanOverview { project, plan } = ctx.view(cx) else {
        return placeholder(cx);
    };
    cx.new(|cx| PlanOverviewPage::new(ctx, project, plan, cx))
        .into()
}

struct PlanOverviewPage {
    ctx: ManageCtx,
    project: SharedString,
    plan: Option<SharedString>,
    canon: Option<CanonOverview>,
    failed: bool,
    /// `busy` of `usePlanOverview`: a reorder is being written.
    busy: bool,
    /// `optimistic`: the order the owner dropped, shown until the board is read again.
    optimistic: Option<Vec<SharedString>>,
    settling: bool,
    create: Option<Entity<EpicCreateDialog>>,
    edit: Option<Entity<PlanFormDialog>>,
    delete: Option<Entity<EpicDeleteDialog>>,
    flight: Flight,
    seen: u64,
}

impl PlanOverviewPage {
    fn new(
        ctx: ManageCtx,
        project: SharedString,
        plan: Option<SharedString>,
        cx: &mut Context<Self>,
    ) -> Self {
        let topic = Topic::Canon(project.clone());
        let seen = ctx.live.read(cx).revision(&topic);
        cx.observe(&ctx.live, move |this, live, cx| {
            let revision = live.read(cx).revision(&topic);
            if revision != this.seen {
                this.seen = revision;
                this.refresh(cx);
            }
        })
        .detach();
        let mut page = Self {
            ctx,
            project,
            plan,
            canon: None,
            failed: false,
            busy: false,
            optimistic: None,
            settling: false,
            create: None,
            edit: None,
            delete: None,
            flight: Flight::default(),
            seen,
        };
        page.refresh(cx);
        page
    }

    /// `board.refresh` (`singleFlight`): reads at most one board at a time.
    fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.flight.begin() {
            self.read(cx);
        }
    }

    fn read(&mut self, cx: &mut Context<Self>) {
        let project = self.project.to_string();
        fetch_if(
            cx,
            move |client| async move { client.get_canon(&project).await },
            |this: &mut Self, result: Result<CanonOverview, Error>, cx| {
                let mut changed = match result {
                    Ok(board) => {
                        let changed = this.failed || this.canon.as_ref() != Some(&board);
                        this.canon = Some(board);
                        this.failed = false;
                        changed
                    }
                    Err(_) => !std::mem::replace(&mut this.failed, true),
                };
                if this.flight.end() {
                    this.read(cx);
                } else if this.settling {
                    this.settling = false;
                    this.optimistic = None;
                    this.busy = false;
                    changed = true;
                }
                changed
            },
        );
    }

    fn plan_cards(&self) -> Option<&PlanCards> {
        let id = self.plan.as_deref()?;
        self.canon
            .as_ref()?
            .plans
            .iter()
            .find(|cards| cards.plan.id == id)
    }

    /// `rows`: the plan's (or the backlog's) epics, in the dropped order while one is settling.
    fn rows(&self) -> Vec<&EpicCard> {
        let Some(canon) = &self.canon else {
            return Vec::new();
        };
        let original = if self.plan.is_some() {
            self.plan_cards().map_or(&[][..], |cards| &cards.works[..])
        } else {
            &canon.backlog[..]
        };
        match &self.optimistic {
            Some(order) => order
                .iter()
                .filter_map(|id| original.iter().find(|epic| epic.id == id.as_ref()))
                .collect(),
            None => original.iter().collect(),
        }
    }

    /// `reorder`: a plan keeps its own order revision, the backlog its project's.
    fn reorder(&mut self, ids: Vec<SharedString>, cx: &mut Context<Self>) {
        let Some(canon) = &self.canon else {
            return;
        };
        if self.busy {
            return;
        }
        let list: Vec<String> = ids.iter().map(ToString::to_string).collect();
        let plan = self.plan_cards().map(|cards| {
            (
                cards.plan.id.clone(),
                json!({ "work_ids": list, "expected_revision": cards.plan.revision }),
            )
        });
        let backlog = json!({ "work_ids": list, "expected_revision": canon.backlog_revision });
        let project = self.project.to_string();
        self.busy = true;
        self.optimistic = Some(ids);
        cx.notify();
        fetch(
            cx,
            move |client| async move {
                match plan {
                    Some((id, body)) => client.order_canon_plan(&id, &body).await,
                    None => client.order_canon_backlog(&project, &backlog).await,
                }
            },
            |this: &mut Self, result: Result<Value, Error>, cx| {
                match result {
                    Ok(_) => {
                        let copy = words(Ds::get(cx).lang());
                        toast::show(cx, Toast::message(copy.reordered));
                    }
                    Err(error) => {
                        write_failure(&error, cx);
                    }
                }
                this.settling = true;
                this.refresh(cx);
            },
        );
    }

    fn dismiss(cx: &mut Context<Self>) -> Action {
        let page = cx.weak_entity();
        Rc::new(move |_: &mut Window, cx: &mut App| {
            let _ = page.update(cx, |this, cx| {
                this.create = None;
                this.edit = None;
                this.delete = None;
                cx.notify();
            });
        })
    }

    /// A row's action (`onWrite`, `onOpen`, `deletion.request`).
    fn act(&mut self, epic: &EpicCard, act: Act, cx: &mut Context<Self>) {
        match act {
            Act::Write(input, message) => self.write_epic(epic, &input, message, cx),
            Act::Open => {
                if let Some(session) = &epic.home_session_id {
                    self.ctx.open_session(session.clone().into(), cx);
                }
            }
            Act::Delete => {
                let on_close = Self::dismiss(cx);
                let page = cx.weak_entity();
                let on_refresh = Rc::new(move |_: &mut Window, cx: &mut App| {
                    let _ = page.update(cx, Self::refresh);
                });
                self.delete =
                    Some(cx.new(|_| EpicDeleteDialog::new(epic.clone(), on_close, on_refresh)));
                cx.notify();
            }
        }
    }

    /// `onWrite`: the epic at the revision the row was read at; the board is read again after.
    fn write_epic(
        &mut self,
        epic: &EpicCard,
        input: &EpicInput,
        message: SharedString,
        cx: &mut Context<Self>,
    ) {
        if self.busy {
            return;
        }
        let Ok(body) = serde_json::to_value(input) else {
            return;
        };
        let id = epic.id.clone();
        self.busy = true;
        cx.notify();
        fetch(
            cx,
            move |client| async move { client.edit_canon_epic(&id, &body).await },
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                match result {
                    Ok(_) => {
                        toast::show(cx, Toast::message(message));
                    }
                    Err(error) => {
                        write_failure(&error, cx);
                    }
                }
                this.settling = true;
                this.refresh(cx);
            },
        );
    }

    fn open_create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(canon) = &self.canon else {
            return;
        };
        let plans = canon.plans.iter().map(|cards| cards.plan.clone()).collect();
        let (ctx, project, plan) = (self.ctx.clone(), self.project.clone(), self.plan.clone());
        let on_close = Self::dismiss(cx);
        let page = cx.weak_entity();
        let on_created = Rc::new(move |_: EpicDetail, _: &mut Window, cx: &mut App| {
            let _ = page.update(cx, Self::refresh);
        });
        self.create = Some(cx.new(|cx| {
            EpicCreateDialog::new(&ctx, project, plans, plan, on_close, on_created, window, cx)
        }));
        cx.notify();
    }

    fn open_edit(&mut self, cx: &mut Context<Self>) {
        let Some(plan) = self.plan_cards().map(|cards| cards.plan.clone()) else {
            return;
        };
        let project = self.project.clone();
        let on_close = Self::dismiss(cx);
        let page = cx.weak_entity();
        let on_refresh = Rc::new(move |_: &mut Window, cx: &mut App| {
            let _ = page.update(cx, Self::refresh);
        });
        self.edit =
            Some(cx.new(|cx| {
                PlanFormDialog::new(project, Some(plan), on_close, on_refresh, None, cx)
            }));
        cx.notify();
    }

    fn header(&self, cx: &mut Context<Self>) -> Stack {
        let copy = words(Ds::get(cx).lang());
        let lang = Ds::get(cx).lang();
        let cards = self.plan_cards();
        let title = cards.map_or_else(
            || SharedString::from(copy.backlog),
            |cards| SharedString::from(cards.plan.title.clone()),
        );
        let meta = cards
            .and_then(|cards| cards.plan.due_on.as_deref())
            .and_then(|due| copy.day(due, lang))
            .map(|date| SharedString::from((copy.due)(&date)));
        let page = cx.entity();
        let mut actions = button::container(Size::Default);
        if cards.is_some() {
            let edit = page.clone();
            actions = actions.child(
                IconButton::new("canon-plan-edit", copy.edit_plan)
                    .glyph(Icon::Pencil)
                    .on_click(move |_, _, cx| {
                        edit.update(cx, Self::open_edit);
                    }),
            );
        }
        let create = Button::new("canon-plan-new-epic")
            .icon_start(icon(Icon::Plus, IconSize::Sm, Ds::get(cx)))
            .text(copy.new_epic)
            .on_click(move |_, window, cx| {
                page.update(cx, |this, cx| this.open_create(window, cx));
            });
        let create = if self.canon.is_none() || self.busy {
            create.disabled()
        } else {
            create
        };
        let mut header = DashboardHeader::new(title).action(actions.child(create));
        if let Some(meta) = meta {
            header = header.meta(meta);
        }
        let caption = if self.plan.is_some() {
            copy.plan
        } else {
            copy.no_plan
        };
        let mut head = Stack::new()
            .gap(Space::Md)
            .child(Typo::caption(caption).tone(Tone::Secondary))
            .child(header);
        if let Some(cards) = cards {
            head = head.child(self.summary(cards, cx));
        }
        head
    }

    /// The plan's description and its progress meter.
    fn summary(&self, cards: &PlanCards, cx: &App) -> Stack {
        let copy = words(Ds::get(cx).lang());
        let rows = self.rows();
        let done = rows
            .iter()
            .filter(|epic| epic.canon_status == CanonStatus::Done)
            .count();
        #[allow(clippy::cast_precision_loss, reason = "epic counts are small")]
        let value = if rows.is_empty() {
            0.
        } else {
            done as f32 / rows.len() as f32 * 100.
        };
        let mut summary = Stack::new().gap(Space::Sm);
        if !cards.plan.description.is_empty() {
            summary = summary.child(Typo::body(cards.plan.description.clone()).wrap(Wrap::Pre));
        }
        summary.child(
            ProgressMeter::new("canon-plan-progress", value)
                .label(copy.progress)
                .meta((copy.done)(done, rows.len())),
        )
    }

    fn body(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let copy = words(Ds::get(cx).lang());
        let page = cx.entity();
        if self.failed {
            let retry =
                Button::new("canon-plan-retry")
                    .text(copy.retry)
                    .on_click(move |_, _, cx| {
                        page.update(cx, Self::refresh);
                    });
            return Notice::new(NoticeTone::Error, copy.request_failed)
                .action(retry)
                .into_any_element();
        }
        if self.canon.is_none() {
            return ProgressMeter::indeterminate("canon-plan-loading")
                .label(copy.loading)
                .into_any_element();
        }
        if self.plan.is_some() && self.plan_cards().is_none() {
            return Notice::new(NoticeTone::Info, copy.plan_missing).into_any_element();
        }
        let reorder = page.clone();
        let on_act: OnAct = Rc::new(move |epic: &EpicCard, act: Act, cx: &mut App| {
            let epic = epic.clone();
            page.update(cx, |this, cx| this.act(&epic, act, cx));
        });
        let plans = self
            .canon
            .iter()
            .flat_map(|canon| canon.plans.iter().map(|cards| cards.plan.clone()))
            .collect();
        let props = ListProps {
            backlog: self.plan.is_none(),
            busy: self.busy,
            compact: Ds::get(cx).compact(),
            plans: Rc::new(plans),
            on_reorder: Rc::new(
                move |ids: Vec<SharedString>, _: &mut Window, cx: &mut App| {
                    reorder.update(cx, |this, cx| this.reorder(ids, cx));
                },
            ),
            on_act,
            lang: Ds::get(cx).lang(),
        };
        epic_list(&self.rows(), props).into_any_element()
    }
}

impl Render for PlanOverviewPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // CARVE-OUT(G-wall): React fills `background` with the project's wallpaper
        // (`useProjectDashboardBackground`) and keeps its column clear (`onColumnRect`).
        let content = Stack::new()
            .gap(Space::Xl)
            .child(self.header(cx))
            .child(Stack::new().gap(Space::Xl).child(self.body(cx)));
        let page = ManagementPage::new("canon-plan-overview")
            .background_treatment(BackgroundTreatment::None)
            .child(content);
        div()
            .id("canon-plan-overview-page")
            .size_full()
            .child(anchor(div().size_full(), "canon-plan-overview").child(page))
            .children(self.create.clone())
            .children(self.edit.clone())
            .children(self.delete.clone())
    }
}
