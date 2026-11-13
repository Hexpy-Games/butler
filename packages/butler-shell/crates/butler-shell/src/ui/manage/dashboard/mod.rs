//! The project dashboard (`management/ProjectDashboardView.tsx`, `ProjectDashboardHeader.tsx`,
//! `ProjectOverviewPanel.tsx`, `hooks/useProjectDashboard.ts`): header, tabs, the canon board and
//! aside, and the window's composer in its footer (`ctx.composer`).
#![allow(dead_code, reason = "seam API: M8 reads DashboardCtx; F6 removes this")]
mod copy;
mod document;
mod header;
mod overview;
mod selection;
mod state;
pub(crate) mod tabs;
mod view;

use std::rc::Rc;

use gpui::{AnyView, App, AppContext as _, SharedString, Window};

use super::{Action, ManageCtx, Pick};
use crate::ui::source::wire::{ProjectDashboardDocument, ProjectDashboardPreferences};

/// The dashboard's tabs (`ProjectDashboardView` tab ids).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum DashboardTab {
    Overview,
    Work,
    Materials,
    History,
    Statistics,
}

impl DashboardTab {
    const ALL: [Self; 5] = [
        Self::Overview,
        Self::Work,
        Self::Materials,
        Self::History,
        Self::Statistics,
    ];

    /// The tab's id in the tab list and the scene anchors.
    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::Overview => "overview",
            Self::Work => "work",
            Self::Materials => "materials",
            Self::History => "history",
            Self::Statistics => "statistics",
        }
    }

    fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|tab| tab.id() == id)
    }
}

/// What the dashboard hands its tab panels.
#[derive(Clone)]
pub(crate) struct DashboardCtx {
    pub(crate) manage: ManageCtx,
    pub(crate) project: SharedString,
    pub(crate) preferences: Option<Rc<ProjectDashboardPreferences>>,
    pub(crate) revision: SharedString,
    pub(crate) select: Pick<ProjectDashboardDocument>,
    pub(crate) set_tab: Pick<DashboardTab>,
    pub(crate) updated: Action,
    pub(crate) open_session: Pick<SharedString>,
}

/// `ProjectDashboardView`
pub(crate) fn page(ctx: ManageCtx, window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| state::DashboardPage::new(ctx, window, cx))
        .into()
}

/// Electron `canonNavigation.ts::openCanonEpic`: use the shell's management navigation.
pub(crate) fn open_canon_epic(project: &str, epic: Option<&str>, cx: &mut App) {
    let Some(ctx) = crate::ui::manage::window_ctx(cx) else {
        return;
    };
    state::open_work(project, cx);
    ctx.open_project_dashboard(project.to_owned().into(), cx);
    crate::ui::manage::canon::aside::select_epic(
        &ctx,
        project.to_owned().into(),
        epic.map(|id| id.to_owned().into()),
        cx,
    );
}
