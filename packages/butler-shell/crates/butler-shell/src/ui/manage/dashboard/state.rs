//! `useProjectDashboard` and `useProjectDashboardScroll` as one page entity: the dashboard read
//! (on open, every 30 s, on window focus, and after `Topic::Dashboard` moves, debounced), the
//! tab and scroll kept per project, and the pieces the page is built from.
use gpui::AppContext as _;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

use butler_shell_client::Error;
use gpui::{App, Context, Entity, Global, ScrollHandle, SharedString, Task, Window, point, px};

use super::DashboardTab;
use super::header::description::ProjectDescription;
use super::overview::briefing::{BriefingPanel, Section};
use super::selection::Selection;
use super::tabs::{HistoryPanel, MaterialsPanel, ResultsPanel, StatisticsPanel};
use crate::ui::manage::canon::aside::CanonAside;
use crate::ui::manage::canon::board::CanonBoard;
use crate::ui::manage::{ManageCtx, Topic, View};
use crate::ui::source::fetch::{fetch_if, poll_every, sleep};
use crate::ui::source::wire::{
    DashboardOverview, ProjectDashboardDocument, ProjectDashboardView, SessionSummary,
};

/// A page callback that needs no window (it runs from a finished read).
pub(super) type Refresh = Rc<dyn Fn(&mut App)>;
/// Opens a project document.
pub(super) type Select = Rc<dyn Fn(ProjectDashboardDocument, &mut App)>;

/// `request.status` of `useProjectDashboard`.
pub(super) enum Phase {
    Loading,
    Ready(Rc<ProjectDashboardView>),
    Error,
}

/// A panel and the key it was built for; a new key builds a new panel (React's `key`).
pub(super) struct Slot<T> {
    key: SharedString,
    pub(super) view: Entity<T>,
}

impl<T: 'static> Slot<T> {
    pub(super) fn get(
        slot: &mut Option<Self>,
        key: SharedString,
        make: impl FnOnce() -> Entity<T>,
    ) -> Entity<T> {
        if let Some(held) = slot.as_ref().filter(|held| held.key == key) {
            return held.view.clone();
        }
        let view = make();
        *slot = Some(Self {
            key,
            view: view.clone(),
        });
        view
    }
}

/// The tab panels, mounted while their tab shows.
#[derive(Default)]
pub(super) struct Panels {
    pub(super) short_materials: Option<Slot<MaterialsPanel>>,
    pub(super) materials: Option<Slot<MaterialsPanel>>,
    pub(super) results: Option<Slot<ResultsPanel>>,
    pub(super) history: Option<Slot<HistoryPanel>>,
    pub(super) statistics: Option<Slot<StatisticsPanel>>,
    pub(super) board: Option<Entity<CanonBoard>>,
    pub(super) aside: Option<(SharedString, Entity<CanonAside>)>,
}

/// `useProjectDashboardState`: what outlives the page of a project.
#[derive(Default)]
struct Memory(HashMap<SharedString, Remembered>);

#[derive(Default)]
struct Remembered {
    tab: Option<DashboardTab>,
    scroll: HashMap<DashboardTab, f32>,
}

impl Global for Memory {}

pub(super) struct DashboardPage {
    pub(super) ctx: ManageCtx,
    pub(super) project: SharedString,
    pub(super) phase: Phase,
    pub(super) refresh_failed: bool,
    pub(super) tab: DashboardTab,
    pub(super) selection: Selection,
    pub(super) description: Entity<ProjectDescription>,
    pub(super) position: Entity<BriefingPanel>,
    pub(super) suggestions: Entity<BriefingPanel>,
    pub(super) panels: Panels,
    /// The room the overlay composer keeps (`composerHeight`).
    pub(super) composer_height: f32,
    /// The composer entity the page follows, so its height changes redraw the page.
    pub(super) composer_watch: Option<(gpui::EntityId, gpui::Subscription)>,
    /// `expandedDocument`: the document whose source details are open.
    pub(super) expanded: Option<String>,
    scroll: Option<ScrollHandle>,
    restoring: Option<f32>,
    restored_at: Option<f32>,
    requests: u64,
    live_revision: u64,
    first_dirty: Option<Instant>,
    debounce: Option<Task<()>>,
    _poll: Task<()>,
}

impl DashboardPage {
    pub(super) fn new(ctx: ManageCtx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let project = match ctx.view(cx) {
            View::ProjectDashboard { project, .. } => project,
            _ => SharedString::default(),
        };
        let remembered = cx
            .default_global::<Memory>()
            .0
            .entry(project.clone())
            .or_default();
        let tab = remembered.tab.unwrap_or(DashboardTab::Overview);
        let restoring = Some(remembered.scroll.get(&tab).copied().unwrap_or(0.));
        let page = cx.weak_entity();
        let refresh: Refresh = {
            let page = page.clone();
            Rc::new(move |cx| {
                let _ = page.update(cx, DashboardPage::refresh);
            })
        };
        let select: Select = Rc::new(move |document, cx| {
            let _ = page.update(cx, |this, cx| this.select_document(document, cx));
        });
        let live_revision = ctx
            .live
            .read(cx)
            .revision(&Topic::Dashboard(project.clone()));
        Self::follow(&ctx, window, cx);
        let poll = poll_every(cx, Duration::from_secs(30), DashboardPage::refresh);
        let mut page = Self {
            description: cx.new(|_| ProjectDescription::new(project.clone(), refresh.clone())),
            position: cx.new(|_| {
                BriefingPanel::new(
                    Section::Position,
                    ctx.clone(),
                    project.clone(),
                    select.clone(),
                    refresh.clone(),
                )
            }),
            suggestions: cx.new(|_| {
                BriefingPanel::new(
                    Section::Suggestions,
                    ctx.clone(),
                    project.clone(),
                    select,
                    refresh,
                )
            }),
            ctx,
            project,
            phase: Phase::Loading,
            refresh_failed: false,
            tab,
            selection: Selection::default(),
            panels: Panels::default(),
            composer_height: 160.,
            composer_watch: None,
            expanded: None,
            scroll: None,
            restoring,
            restored_at: None,
            requests: 0,
            live_revision,
            first_dirty: None,
            debounce: None,
            _poll: poll,
        };
        let active = window.is_window_active();
        for panel in [&page.position, &page.suggestions] {
            panel.update(cx, |panel, cx| panel.set_active(active, cx));
        }
        page.refresh(cx);
        page
    }

    /// What redraws or refreshes the page: the shell's state, the dashboard topic (debounced),
    /// the window coming forward, and the page going away (the scroll is kept).
    fn follow(ctx: &ManageCtx, window: &mut Window, cx: &mut Context<Self>) {
        cx.observe(&ctx.state, |_, _, cx| cx.notify()).detach();
        cx.observe(&ctx.live, |this, live, cx| {
            let topic = Topic::Dashboard(this.project.clone());
            let revision = live.read(cx).revision(&topic);
            if revision != this.live_revision {
                this.live_revision = revision;
                this.mark_dirty(cx);
            }
        })
        .detach();
        cx.observe_window_activation(window, |this, window, cx| {
            let active = window.is_window_active();
            for panel in [&this.position, &this.suggestions] {
                panel.update(cx, |panel, cx| panel.set_active(active, cx));
            }
            if active {
                this.refresh(cx);
            }
        })
        .detach();
        cx.on_release(|this, cx| this.remember_scroll(cx)).detach();
    }

    /// The effect of `useProjectDashboard`: read `/projects/{id}/dashboard`.
    pub(super) fn refresh(&mut self, cx: &mut Context<Self>) {
        self.requests += 1;
        let (request, project) = (self.requests, self.project.to_string());
        fetch_if(
            cx,
            move |client| async move { client.get_project_dashboard(&project).await },
            move |this: &mut Self, result: Result<ProjectDashboardView, Error>, cx| {
                this.loaded(request, result, cx)
            },
        );
    }

    /// Whether the page changed: an unchanged answer draws nothing.
    fn loaded(
        &mut self,
        request: u64,
        result: Result<ProjectDashboardView, Error>,
        cx: &mut Context<Self>,
    ) -> bool {
        if request != self.requests {
            return false;
        }
        match result {
            Ok(view) => {
                let recovered = std::mem::take(&mut self.refresh_failed);
                if matches!(&self.phase, Phase::Ready(old) if **old == view) {
                    return recovered;
                }
                self.phase = Phase::Ready(Rc::new(view));
                self.sync(cx);
                true
            }
            Err(_) if matches!(self.phase, Phase::Ready(_)) => {
                !std::mem::replace(&mut self.refresh_failed, true)
            }
            Err(_) => {
                self.phase = Phase::Error;
                true
            }
        }
    }

    /// The new dashboard reaches the parts that keep their own state.
    fn sync(&mut self, cx: &mut Context<Self>) {
        let Phase::Ready(data) = &self.phase else {
            return;
        };
        let data = Rc::clone(data);
        let revision = data.preferences.as_ref().map_or(0, |p| p.revision);
        self.description.update(cx, |this, cx| {
            this.set(data.description.clone(), revision, cx);
        });
        let briefing = data.briefing.clone().map(Rc::new);
        for panel in [&self.position, &self.suggestions] {
            panel.update(cx, |this, cx| this.set(briefing.clone(), cx));
        }
    }

    /// `retry`
    pub(super) fn retry(&mut self, cx: &mut Context<Self>) {
        if matches!(self.phase, Phase::Error) {
            self.phase = Phase::Loading;
        }
        self.refresh_failed = false;
        cx.notify();
        self.refresh(cx);
    }

    /// An invalidation: read again at least 2 s later, at most 10 s after the first one.
    fn mark_dirty(&mut self, cx: &mut Context<Self>) {
        let first = *self.first_dirty.get_or_insert_with(Instant::now);
        let wait = Duration::from_secs(10)
            .saturating_sub(first.elapsed())
            .min(Duration::from_secs(2));
        self.debounce = Some(cx.spawn(async move |this, cx| {
            sleep(cx, wait).await;
            let _ = this.update(cx, |this, cx| {
                this.first_dirty = None;
                this.refresh(cx);
            });
        }));
    }

    pub(super) fn set_tab(&mut self, tab: DashboardTab, cx: &mut Context<Self>) {
        if tab == self.tab {
            return;
        }
        self.remember_scroll(cx);
        self.tab = tab;
        let memory = cx
            .default_global::<Memory>()
            .0
            .entry(self.project.clone())
            .or_default();
        memory.tab = Some(tab);
        self.restoring = Some(memory.scroll.get(&tab).copied().unwrap_or(0.));
        self.restored_at = None;
        cx.notify();
    }

    fn remember_scroll(&self, cx: &mut App) {
        let Some(scroll) = self.scroll.as_ref().filter(|_| self.restoring.is_none()) else {
            return;
        };
        let at = (-f32::from(scroll.offset().y)).max(0.);
        cx.default_global::<Memory>()
            .0
            .entry(self.project.clone())
            .or_default()
            .scroll
            .insert(self.tab, at);
    }

    /// Restores the saved offset until the content is long enough or the owner scrolls.
    pub(super) fn restore_scroll(&mut self, scroll: ScrollHandle) {
        let Some(target) = self.restoring else {
            self.scroll = Some(scroll);
            return;
        };
        let offset = scroll.offset();
        if self
            .restored_at
            .is_some_and(|set| (-f32::from(offset.y) - set).abs() > 1.)
        {
            self.restoring = None;
        } else {
            let want = target.min(f32::from(scroll.max_offset().y));
            scroll.set_offset(point(offset.x, px(-want)));
            self.restored_at = Some(want);
            if (want - target).abs() < 1. {
                self.restoring = None;
            }
        }
        self.scroll = Some(scroll);
    }

    /// `ledgerRevision`
    pub(super) fn ledger_revision(&self) -> String {
        match &self.phase {
            Phase::Ready(data) => match &data.overview {
                Some(DashboardOverview::Ready(ready)) => ready.source_revision.clone(),
                _ => "unavailable".to_owned(),
            },
            _ => "unavailable".to_owned(),
        }
    }

    /// `publicRevision`: the ledger revision and each session's activity.
    pub(super) fn public_revision(&self, cx: &App) -> String {
        let navigation = self.ctx.navigation(cx);
        let shown = navigation
            .as_deref()
            .and_then(|n| n.projects.iter().find(|p| p.id == self.project.as_ref()));
        let live: &[SessionSummary] = shown.and_then(|p| p.sessions.as_deref()).unwrap_or(&[]);
        let held = match &self.phase {
            Phase::Ready(data) => data.project.sessions.as_deref(),
            _ => None,
        };
        let mut merged: Vec<&SessionSummary> = held.unwrap_or(live).iter().collect();
        for session in live {
            match merged.iter().position(|old| old.id == session.id) {
                Some(at) if session.updated_at >= merged[at].updated_at => merged[at] = session,
                Some(_) => {}
                None => merged.push(session),
            }
        }
        let sessions = merged
            .iter()
            .map(|s| {
                let state = s
                    .active_turn_state
                    .as_ref()
                    .map_or(String::new(), |t| format!("{t:?}"));
                format!("{}:{}:{state}", s.id, s.last_activity_at)
            })
            .collect::<Vec<_>>()
            .join("|");
        format!("{}:{sessions}", self.ledger_revision())
    }

    /// Panels of a tab that is not showing are dropped, as React unmounts its content.
    pub(super) fn unmount_inactive(&mut self) {
        let tab = self.tab;
        if tab != DashboardTab::Overview {
            self.panels.short_materials = None;
        }
        if tab != DashboardTab::Work {
            self.panels.board = None;
        }
        if tab != DashboardTab::Materials {
            self.panels.materials = None;
            self.panels.results = None;
        }
        if tab != DashboardTab::History {
            self.panels.history = None;
        }
        if tab != DashboardTab::Statistics {
            self.panels.statistics = None;
        }
    }
}
