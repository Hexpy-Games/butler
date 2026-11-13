//! The canon board, the dashboard's work tab (`canon/CanonBoard.tsx`, `useCanonBoard.ts`,
//! `CanonPlanLanes.tsx`, `EpicCard.tsx`, `useCanonMove.ts`).
pub(crate) mod card;
mod copy;
mod data;
mod lanes;
mod moves;
mod plan_lanes;
mod plan_select;

use std::rc::Rc;

use butler_ds::ui::blocks::kanban_board::KanbanDragScope;
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Justify, MinWidth, Space, Stack, WithItem as _};
use butler_ds::ui::typo::Typo;
use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, Window, div,
};

use copy::{drag_labels, words};
use lanes::{can_complete, find_card};
use plan_lanes::{Container, Lanes, plan_lanes};
use plan_select::Picker;

use crate::ui::Icon;
use crate::ui::manage::Action;
use crate::ui::manage::canon::aside::{select_epic, selected_epic};
use crate::ui::manage::canon::common::{CanonTags, OnTags, TagChooser};
use crate::ui::manage::canon::plan::{EpicCreateDialog, PlanFormDialog};
use crate::ui::manage::{ManageCtx, Pick, Topic};
use crate::ui::source::fetch::Flight;
use crate::ui::source::wire::{CanonOverview, CanonPlan, EpicDetail, PlanCards};
use crate::ui::widgets::anchor;

/// `CanonBoard` (`bottom_inset`: the room the dashboard's composer footer keeps).
pub(crate) struct CanonBoard {
    ctx: ManageCtx,
    project: SharedString,
    canon: Option<Rc<CanonOverview>>,
    /// `board.error`
    failed: bool,
    flight: Flight,
    /// `generation`: a move or a newer read makes an older answer stale.
    generation: u64,
    /// `movingRef` / `moving`
    moving: bool,
    /// The canon topic revision this board last read.
    seen: u64,
    tags: Entity<CanonTags>,
    tag_chooser: Entity<TagChooser>,
    /// `tagFilter`: tag ids.
    tag_filter: Vec<SharedString>,
    picker: Picker,
    /// `shownFor` in Electron's `CanonBoard.tsx`.
    shown_for: Option<SharedString>,
    /// `create`: the new-epic dialog.
    create: Option<Entity<EpicCreateDialog>>,
    /// `planForm`: the new-plan or edit-plan dialog.
    plan_form: Option<Entity<PlanFormDialog>>,
}

impl CanonBoard {
    pub(crate) fn new(
        ctx: ManageCtx,
        project: SharedString,
        // CARVE-OUT(G-ds): React hands `bottom_inset` to the plan picker as popover collision
        // padding; `PopoverContent` has no collision padding, so the picker ignores it.
        _bottom_inset: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let tags = cx.new(|cx| CanonTags::new(project.clone(), &ctx.live, cx));
        cx.observe(&tags, |this, _, cx| this.drop_deleted_tags(cx))
            .detach();
        let weak = cx.entity().downgrade();
        let on_filter: OnTags = Rc::new(move |ids, _, cx| {
            let _ = weak.update(cx, |this, cx| {
                this.tag_filter = ids;
                cx.notify();
            });
        });
        let tag_chooser =
            cx.new(|cx| TagChooser::new(tags.clone(), Vec::new(), on_filter, true, window, cx));
        cx.observe(&ctx.live, |this, _, cx| this.live_moved(cx))
            .detach();
        let seen = ctx.live.read(cx).revision(&Topic::Canon(project.clone()));
        let mut this = Self {
            ctx,
            project,
            canon: None,
            failed: false,
            flight: Flight::default(),
            generation: 0,
            moving: false,
            seen,
            tags,
            tag_chooser,
            tag_filter: Vec::new(),
            picker: Picker::default(),
            shown_for: None,
            create: None,
            plan_form: None,
        };
        this.refresh(cx);
        this
    }

    /// Electron `CanonBoard.tsx`: a newly selected task brings its container on screen.
    fn follow_selection(&mut self, canon: Option<&CanonOverview>, cx: &mut Context<Self>) {
        let Some(epic) = selected_epic(&self.ctx, &self.project, cx) else {
            self.shown_for = None;
            return;
        };
        let Some(canon) = canon else {
            return;
        };
        if self.shown_for.as_ref() == Some(&epic) {
            return;
        }
        self.shown_for = Some(epic.clone());
        let plan = match plan_select::canon_epic_plan(canon, &epic) {
            Some(plan_select::EpicPlace::Backlog) => None,
            Some(plan_select::EpicPlace::Plan(plan)) => Some(plan),
            None => return,
        };
        if plan != self.plan_id(Some(&canon.plans), cx) {
            plan_select::store_plan_choice(&self.project, plan, cx);
        }
    }

    /// `tagFilter` without the tags that were deleted, so a deleted tag does not leave the board
    /// empty.
    fn effective_filter(&self, cx: &App) -> Vec<SharedString> {
        let tags = self.tags.read(cx).tags();
        self.tag_filter
            .iter()
            .filter(|id| tags.iter().any(|tag| tag.tag.id == ***id))
            .cloned()
            .collect()
    }

    /// A deleted tag leaves the filter, and the chooser shows the filter that is left.
    fn drop_deleted_tags(&mut self, cx: &mut Context<Self>) {
        let kept = self.effective_filter(cx);
        if kept != self.tag_filter {
            self.tag_filter.clone_from(&kept);
            self.tag_chooser
                .update(cx, |chooser, cx| chooser.set_value(kept, cx));
        }
        cx.notify();
    }

    /// `setCreate({ planId })`: the new-epic dialog for `plan`.
    fn open_create(
        &mut self,
        plan: Option<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let plans: Vec<CanonPlan> = self
            .canon
            .as_ref()
            .map(|canon| canon.plans.iter().map(|plan| plan.plan.clone()).collect())
            .unwrap_or_default();
        let board = cx.entity().downgrade();
        let on_close = {
            let board = board.clone();
            Rc::new(move |_: &mut Window, cx: &mut App| {
                let _ = board.update(cx, |this, cx| {
                    this.create = None;
                    cx.notify();
                });
            })
        };
        let on_created = {
            let ctx = self.ctx.clone();
            let project = self.project.clone();
            Rc::new(move |epic: EpicDetail, _: &mut Window, cx: &mut App| {
                let _ = board.update(cx, CanonBoard::refresh);
                select_epic(&ctx, project.clone(), Some(epic.card.id.into()), cx);
            })
        };
        let (ctx, project) = (self.ctx.clone(), self.project.clone());
        let dialog = cx.new(|cx| {
            EpicCreateDialog::new(&ctx, project, plans, plan, on_close, on_created, window, cx)
        });
        self.create = Some(dialog);
        cx.notify();
    }

    /// `PlanFormDialog`: `plan` edits it, `None` creates one and shows it.
    fn open_plan_form(&mut self, plan: Option<CanonPlan>, cx: &mut Context<Self>) {
        let board = cx.entity().downgrade();
        let on_close: Action = {
            let board = board.clone();
            Rc::new(move |_: &mut Window, cx: &mut App| {
                let _ = board.update(cx, |this, cx| {
                    this.plan_form = None;
                    cx.notify();
                });
            })
        };
        let on_refresh: Action = {
            let board = board.clone();
            Rc::new(move |_: &mut Window, cx: &mut App| {
                let _ = board.update(cx, CanonBoard::refresh);
            })
        };
        let on_created: Pick<SharedString> = Rc::new(move |id, _, cx| {
            let _ = board.update(cx, |this, cx| this.choose_plan(Some(id), cx));
        });
        let project = self.project.clone();
        self.plan_form = Some(cx.new(|cx| {
            PlanFormDialog::new(project, plan, on_close, on_refresh, Some(on_created), cx)
        }));
        cx.notify();
    }

    /// The row above the lanes: plan, tag filter, and the two create buttons.
    fn header(
        &self,
        plans: &[PlanCards],
        plan_id: Option<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = words(Ds::get(cx).lang());
        let left = Stack::row()
            .cross(Cross::Center)
            .gap(Space::Sm)
            .wrap(true)
            .shrink(true)
            .min_width(MinWidth::Zero)
            .child(self.plan_select(plans, plan_id.as_ref(), window, cx))
            .child(self.tag_chooser.clone());
        let ds = Ds::get(cx);
        let new_epic = Button::new("canon-new-epic")
            .variant(Variant::Outline)
            .size(Size::Sm)
            .icon_start(icon(Icon::Plus, IconSize::Sm, ds))
            .text(words.new_epic)
            .on_click(cx.listener(move |this, _, window, cx| {
                this.open_create(plan_id.clone(), window, cx);
            }));
        let new_plan = Button::new("canon-new-plan")
            .size(Size::Sm)
            .icon_start(icon(Icon::Plus, IconSize::Sm, ds))
            .text(words.new_plan)
            .on_click(cx.listener(|this, _, _, cx| this.open_plan_form(None, cx)));
        let buttons = button::container(Size::Sm)
            .justify(Justify::End)
            .child(new_epic)
            .child(new_plan);
        Stack::row()
            .cross(Cross::Center)
            .justify(Justify::Between)
            .gap(Space::Sm)
            .wrap(true)
            .child(left)
            .child(buttons)
            .into_any_element()
    }

    /// The Kanban scope around the backlog and the selected plan's lanes.
    fn lanes(
        &self,
        canon: &Rc<CanonOverview>,
        plan_id: Option<&str>,
        selected: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let filter = self.effective_filter(cx);
        let lang = Ds::get(cx).lang();
        let words = words(lang);
        let board = cx.entity().downgrade();
        let ctx = self.ctx.clone();
        let project = self.project.clone();
        let on_select: Pick<SharedString> = Rc::new(move |id, _, cx| {
            let current = selected_epic(&ctx, &project, cx);
            let next = (current.as_ref() != Some(&id)).then_some(id);
            select_epic(&ctx, project.clone(), next, cx);
        });
        let on_create: Pick<Option<SharedString>> = {
            let board = board.clone();
            Rc::new(move |plan, window, cx| {
                let _ = board.update(cx, |this, cx| this.open_create(plan, window, cx));
            })
        };
        let on_edit: Pick<CanonPlan> = {
            let board = board.clone();
            Rc::new(move |plan, _, cx| {
                let _ = board.update(cx, |this, cx| this.open_plan_form(Some(plan), cx));
            })
        };
        let lanes = Lanes {
            filter: &filter,
            selected,
            on_select,
            on_create,
            on_edit,
        };
        let plan = canon
            .plans
            .iter()
            .find(|plan| Some(plan.plan.id.as_str()) == plan_id);
        let (id, title, works, due, edit) = match plan {
            Some(plan) => (
                Some(plan.plan.id.as_str()),
                plan.plan.title.as_str(),
                plan.works.as_slice(),
                plan.plan.due_on.as_deref(),
                Some(&plan.plan),
            ),
            None => (None, words.backlog, canon.backlog.as_slice(), None, None),
        };
        let container = Container {
            id,
            title,
            works,
            caption: words.plan_caption(works, due),
            edit,
        };
        let content = Stack::new()
            .gap(Space::Xl)
            .child(plan_lanes(container, &lanes, window, cx));
        let for_drop = canon.clone();
        KanbanDragScope::new("canon-drag")
            .on_move(move |mv, _, cx| {
                let _ = board.update(cx, |this, cx| this.move_card(&mv, cx));
            })
            .can_drop(move |id, lane| can_complete(find_card(&for_drop, id), lane))
            .labels(drag_labels(lang))
            .disabled(self.moving)
            .child(content)
            .into_any_element()
    }
}

impl Render for CanonBoard {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let words = words(Ds::get(cx).lang());
        let canon = self
            .canon
            .clone()
            .filter(|canon| canon.project_id.as_str() == &*self.project);
        self.follow_selection(canon.as_deref(), cx);
        let plans = canon
            .as_ref()
            .map_or(&[][..], |canon| canon.plans.as_slice());
        let plan_id = self.plan_id(canon.as_ref().map(|_| plans), cx);
        let selected = selected_epic(&self.ctx, &self.project, cx);
        let mut root =
            Stack::new()
                .gap(Space::Lg)
                .child(self.header(plans, plan_id.clone(), window, cx));
        if self.failed {
            root = root.child(
                Stack::row()
                    .cross(Cross::Center)
                    .child(Typo::caption(words.retry_hint))
                    .child(
                        Button::new("canon-board-retry")
                            .variant(Variant::Ghost)
                            .size(Size::Sm)
                            .text(words.retry)
                            .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
                    ),
            );
        }
        match &canon {
            Some(canon) => {
                root = root.child(self.lanes(
                    canon,
                    plan_id.as_deref(),
                    selected.as_deref(),
                    window,
                    cx,
                ));
            }
            None if !self.failed => root = root.child(Typo::caption(words.loading)),
            None => {}
        }
        anchor(div().id("canon-board"), "canon-board")
            .child(root)
            .children(self.create.clone())
            .children(self.plan_form.clone())
    }
}
