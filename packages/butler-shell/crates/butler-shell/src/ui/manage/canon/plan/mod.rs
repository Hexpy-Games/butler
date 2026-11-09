//! The plan overview and the epic create dialog (`canon/PlanOverview.tsx`, `usePlanOverview.ts`,
//! `PlanEpicList.tsx`, `EpicCreateDialog.tsx`, `PlanFormDialog.tsx`, `canonFeedback.ts`,
//! `CanonTrustDialog.tsx`, `canonNavigation.ts`).
mod actions;
mod copy;
mod create;
mod delete;
mod feedback;
mod form;
mod list;
mod overview;
mod trust;

use gpui::{AnyView, App, SharedString, Window};

use crate::ui::manage::{ManageCtx, View};

pub(crate) use create::EpicCreateDialog;
pub(crate) use form::PlanFormDialog;
pub(crate) use trust::CanonTrustDialog;

/// `PlanOverview`
pub(crate) fn page(ctx: ManageCtx, _window: &mut Window, cx: &mut App) -> AnyView {
    overview::page(ctx, cx)
}

/// `openPlanOverview` (canonNavigation.ts): the project's dashboard, then its plan overview.
pub(crate) fn open_plan_overview(
    ctx: &ManageCtx,
    project: SharedString,
    plan: Option<SharedString>,
    cx: &mut App,
) {
    ctx.open_project_dashboard(project.clone(), cx);
    ctx.set_view(View::PlanOverview { project, plan }, cx);
}
