//! `ProjectDashboardView`: the status notices, the header, the tabs and their panels, the epic
//! aside and the window's composer in the footer.
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::management_page::{
    self, AsideLayout, BackgroundTreatment, FooterPlacement, ManagementPage,
};
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::section::Section;
use butler_ds::ui::tabs::{ListVariant, Tabs, TabsList, Trigger};
use gpui::{
    AnyElement, AnyView, AppContext as _, ClickEvent, Context, Entity, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, RenderOnce, SharedString, Styled as _, Window, div,
};

use super::copy::{Words, words};
use super::header::dashboard_header;
use super::overview::Overview;
use super::state::{DashboardPage, Phase, Slot};
use super::tabs::{HistoryPanel, MaterialsPanel, ResultsPanel, StatisticsPanel};
use super::{DashboardCtx, DashboardTab};
use crate::ui::composer::Composer;
use crate::ui::manage::Action;
use crate::ui::manage::canon::aside::{CanonAside, selected_epic};
use crate::ui::manage::canon::board::CanonBoard;
use crate::ui::source::wire::ProjectDashboardView;
use crate::ui::widgets::anchor;

/// The page's id (its scroller is `management_page::scroll_handle` of it).
const PAGE: &str = "project-dashboard-view";

/// The epic aside in the layout the page gives it.
#[derive(IntoElement)]
struct AsideHost {
    aside: Entity<CanonAside>,
    layout: AsideLayout,
}

impl RenderOnce for AsideHost {
    fn render(self, window: &mut Window, cx: &mut gpui::App) -> impl IntoElement {
        self.aside
            .update(cx, |aside, cx| aside.render_aside(self.layout, window, cx))
    }
}

/// What `useProjectDashboard` calls the request.
enum Status {
    Loading,
    Error,
    Missing,
}

impl Render for DashboardPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.unmount_inactive();
        let missing = self.ctx.navigation(cx).is_some_and(|navigation| {
            !navigation
                .projects
                .iter()
                .any(|project| project.id == self.project.as_ref())
        });
        let page = match &self.phase {
            _ if missing => self.status_page(&Status::Missing, cx),
            Phase::Loading => self.status_page(&Status::Loading, cx),
            Phase::Error => self.status_page(&Status::Error, cx),
            Phase::Ready(data) => {
                let data = Rc::clone(data);
                self.ready_page(&data, window, cx)
            }
        };
        anchor(div().id(PAGE).size_full(), PAGE).child(page)
    }
}

impl DashboardPage {
    /// The notice a dashboard that is not ready shows.
    fn status_page(&self, status: &Status, cx: &mut Context<Self>) -> AnyElement {
        let copy = words(Ds::get(cx).lang());
        let action = |id: &'static str, text: &'static str| {
            Button::new(id).variant(Variant::Outline).text(text)
        };
        let notice = match status {
            Status::Loading => Notice::new(NoticeTone::Info, copy.dashboard_loading),
            Status::Error => Notice::new(NoticeTone::Error, copy.dashboard_retry)
                .title(copy.dashboard_failed)
                .action(
                    action("dashboard-retry", copy.retry)
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.retry(cx))),
                ),
            Status::Missing => {
                let ctx = self.ctx.clone();
                Notice::new(NoticeTone::Info, copy.project_missing_help)
                    .title(copy.project_missing)
                    .action(
                        action("dashboard-new-chat", copy.new_chat)
                            .on_click(move |_, _, cx| ctx.open_new_chat(cx)),
                    )
            }
        };
        // CARVE-OUT(G-wall): React lays the project wallpaper behind the page here.
        ManagementPage::new(PAGE)
            .background_treatment(BackgroundTreatment::None)
            .child(
                anchor(
                    div().id("project-dashboard-status"),
                    "project-dashboard-status",
                )
                .child(notice),
            )
            .into_any_element()
    }

    /// The page once the dashboard is read.
    fn ready_page(
        &mut self,
        data: &Rc<ProjectDashboardView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let copy = words(Ds::get(cx).lang());
        let handle = management_page::scroll_handle(PAGE, window, cx);
        self.restore_scroll(handle);
        let ctx = self.dashboard_ctx(data, cx);
        let composer = self.follow_composer(cx);
        let selected = selected_epic(&self.ctx, &self.project, cx);
        let aside = self.aside_for(selected.clone(), window, cx);
        let tabs = self.tabs(data, &ctx, copy, window, cx);
        let failed = self.refresh_failed.then(|| {
            Notice::new(NoticeTone::Error, copy.dashboard_retry)
                .title(copy.dashboard_failed)
                .action(
                    Button::new("dashboard-refresh-retry")
                        .variant(Variant::Outline)
                        .text(copy.retry)
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.retry(cx))),
                )
        });
        let open_chat = {
            let (manage, project) = (self.ctx.clone(), self.project.clone());
            let action: Action =
                Rc::new(move |_, cx| manage.open_project_chat(project.clone(), cx));
            action
        };
        let title = SharedString::from(data.project.display_name.clone());
        let main = Stack::new()
            .gap(Space::Xl)
            .children(failed)
            .child(
                Stack::new()
                    .gap(Space::Xl)
                    .child(dashboard_header(title, Some(open_chat), cx))
                    .child(self.description.clone()),
            )
            .child(Stack::new().gap(Space::Xl).child(tabs));
        let dialog = self.document_dialog(window, cx);
        let mut page = ManagementPage::new(PAGE)
            .background_treatment(BackgroundTreatment::None)
            .aside_float_open(selected.is_some())
            .aside_label(copy.epic)
            .footer_placement(FooterPlacement::Overlay)
            .footer_reserve(self.composer_height);
        if let Some(aside) = aside {
            page = page.aside(move |layout| {
                AsideHost {
                    aside: aside.clone(),
                    layout,
                }
                .into_any_element()
            });
        }
        if let Some(composer) = composer {
            page = page.footer(composer);
        }
        page.child(main).children(dialog).into_any_element()
    }

    /// The `DashboardCtx` the tab panels are built with.
    fn dashboard_ctx(&self, data: &ProjectDashboardView, cx: &mut Context<Self>) -> DashboardCtx {
        let page = cx.weak_entity();
        let manage = self.ctx.clone();
        let (select_page, tab_page, updated_page) = (page.clone(), page.clone(), page);
        DashboardCtx {
            manage: self.ctx.clone(),
            project: self.project.clone(),
            preferences: data.preferences.clone().map(Rc::new),
            revision: self.public_revision(cx).into(),
            select: Rc::new(move |document, _, cx| {
                let _ = select_page.update(cx, |this, cx| this.select_document(document, cx));
            }),
            set_tab: Rc::new(move |tab, _, cx| {
                let _ = tab_page.update(cx, |this, cx| this.set_tab(tab, cx));
            }),
            updated: Rc::new(move |_, cx| {
                let _ = updated_page.update(cx, super::state::DashboardPage::refresh);
            }),
            open_session: Rc::new(move |id, _, cx| manage.open_session(id, cx)),
        }
    }

    /// The window's composer, which the footer shows; its height decides the room kept for it.
    fn follow_composer(&mut self, cx: &mut Context<Self>) -> Option<AnyView> {
        let view = self.ctx.composer(cx);
        let entity = view
            .clone()
            .and_then(|view| view.downcast::<Composer>().ok());
        let Some(entity) = entity else {
            self.composer_watch = None;
            return view;
        };
        if self.composer_watch.as_ref().map(|(id, _)| *id) != Some(entity.entity_id()) {
            let watch = cx.observe(&entity, |_, _, cx| cx.notify());
            self.composer_watch = Some((entity.entity_id(), watch));
        }
        let height = entity.read(cx).height_cell().get();
        if height > 0. {
            self.composer_height = height;
        }
        view
    }

    /// `CanonAside key={selected}`: one aside per selected epic.
    fn aside_for(
        &mut self,
        selected: Option<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<CanonAside>> {
        let Some(epic) = selected else {
            self.panels.aside = None;
            return None;
        };
        if let Some((held, aside)) = &self.panels.aside
            && *held == epic
        {
            return Some(aside.clone());
        }
        let (ctx, project) = (self.ctx.clone(), self.project.clone());
        let key = epic.clone();
        let aside = cx.new(|cx| CanonAside::new(ctx, project, epic, window, cx));
        cx.observe(&aside, |_, _, cx| cx.notify()).detach();
        self.panels.aside = Some((key, aside.clone()));
        Some(aside)
    }

    /// The tab list and the active tab's content.
    fn tabs(
        &mut self,
        data: &Rc<ProjectDashboardView>,
        ctx: &DashboardCtx,
        copy: &'static Words,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let page = cx.weak_entity();
        let list = TabsList::new(copy.project_moment)
            .variant(ListVariant::Line)
            .triggers(DashboardTab::ALL.map(|tab| trigger(tab, copy)));
        let content = match self.tab {
            DashboardTab::Overview => self.overview_tab(data, ctx, copy, window, cx),
            DashboardTab::Work => self.work_tab(window, cx),
            DashboardTab::Materials => self.materials_tab(data, ctx, window, cx),
            DashboardTab::History => {
                let key = self.public_key(cx);
                Slot::get(&mut self.panels.history, key, || {
                    cx.new(|cx| HistoryPanel::new(ctx.clone(), window, cx))
                })
                .into_any_element()
            }
            DashboardTab::Statistics => {
                // React gives the panel no key: a revision change refetches, the period stays.
                let revision = self.public_revision(cx);
                let key = SharedString::from(self.project.to_string());
                let panel = Slot::get(&mut self.panels.statistics, key, || {
                    cx.new(|cx| StatisticsPanel::new(ctx.clone(), revision.clone(), window, cx))
                });
                panel.update(cx, |panel, cx| panel.set_revision(revision, cx));
                panel.into_any_element()
            }
        };
        Tabs::new("dashboard-tabs")
            .value(self.tab.id())
            .gap(Space::Xxl)
            .on_value_change(move |id, _, cx| {
                if let Some(tab) = DashboardTab::from_id(id) {
                    let _ = page.update(cx, |this, cx| this.set_tab(tab, cx));
                }
            })
            .list(list)
            .panel(self.tab.id(), content)
            .into_any_element()
    }

    /// `${project.id}:${publicRevision}`
    fn public_key(&self, cx: &Context<Self>) -> SharedString {
        format!("{}:{}", self.project, self.public_revision(cx)).into()
    }

    /// `${project.id}:${ledgerRevision}:${dashboard?.preferences?.revision}`
    fn ledger_key(&self, data: &ProjectDashboardView) -> SharedString {
        let preferences = data
            .preferences
            .as_ref()
            .map_or_else(|| "undefined".to_owned(), |p| p.revision.to_string());
        format!("{}:{}:{preferences}", self.project, self.ledger_revision()).into()
    }

    fn overview_tab(
        &mut self,
        data: &Rc<ProjectDashboardView>,
        ctx: &DashboardCtx,
        copy: &'static Words,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = self.ledger_key(data);
        let short = Slot::get(&mut self.panels.short_materials, key, || {
            cx.new(|cx| MaterialsPanel::new(ctx.clone(), Some(4), window, cx))
        });
        let aside = Section::new("overview-materials")
            .title(copy.important_materials)
            .description(copy.important_materials_help)
            .child(short);
        let set_tab = ctx.set_tab.clone();
        let show_all: Action = Rc::new(move |window, cx| set_tab(DashboardTab::Work, window, cx));
        let overview = Overview {
            data: data.overview.as_ref(),
            project: &self.project,
            select: &ctx.select,
            show_all: &show_all,
        };
        let mut stack = Stack::new().gap(Space::Xxl);
        if self.position.read(cx).visible() {
            stack = stack.child(self.position.clone());
        }
        stack = stack.child(overview.render(Some(aside.into_any_element()), cx));
        if self.suggestions.read(cx).visible() {
            stack = stack.child(self.suggestions.clone());
        }
        stack.into_any_element()
    }

    fn work_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let (ctx, project, inset) = (self.ctx.clone(), self.project.clone(), self.composer_height);
        self.panels
            .board
            .get_or_insert_with(|| cx.new(|cx| CanonBoard::new(ctx, project, inset, window, cx)))
            .clone()
            .into_any_element()
    }

    fn materials_tab(
        &mut self,
        data: &Rc<ProjectDashboardView>,
        ctx: &DashboardCtx,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let ledger = self.ledger_key(data);
        let public = self.public_key(cx);
        let materials = Slot::get(&mut self.panels.materials, ledger, || {
            cx.new(|cx| MaterialsPanel::new(ctx.clone(), None, window, cx))
        });
        let results = Slot::get(&mut self.panels.results, public, || {
            cx.new(|cx| ResultsPanel::new(ctx.clone(), window, cx))
        });
        Stack::new()
            .gap(Space::Xl)
            .child(materials)
            .child(results)
            .into_any_element()
    }
}

/// A tab's trigger.
fn trigger(tab: DashboardTab, copy: &Words) -> Trigger {
    let (label, glyph) = match tab {
        DashboardTab::Overview => (copy.tab_overview, Icon::LayoutDashboard),
        DashboardTab::Work => (copy.tab_work, Icon::ListChecks),
        DashboardTab::Materials => (copy.tab_materials, Icon::Folder),
        DashboardTab::History => (copy.tab_history, Icon::History),
        DashboardTab::Statistics => (copy.tab_statistics, Icon::Activity),
    };
    Trigger::new(tab.id(), label)
        .icon(glyph)
        .anchor(format!("dashboard-tab-{}", tab.id()))
}
