//! `LogTraceTitle.tsx`: Logs > Message trace under the page title; Logs returns to the list.
use butler_ds::ui::blocks::breadcrumb::{
    Breadcrumb, BreadcrumbButton, BreadcrumbItem, BreadcrumbList, BreadcrumbPage,
    BreadcrumbSeparator,
};
use butler_ds::ui::context::Ds;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::copy;
use crate::ui::settings::{Action, SectionId};

pub(crate) fn trace_title(on_logs: Action, _: &mut Window, cx: &mut App) -> AnyElement {
    let copy = copy::get(cx);
    let logs = SectionId::Logs.copy(Ds::get(cx).lang()).label;
    let back = BreadcrumbButton::new("logs-trace-logs")
        .on_click(move |_, window, cx| on_logs(window, cx))
        .child(logs);
    let list = BreadcrumbList::new()
        .child(BreadcrumbItem::new().child(back))
        .child(BreadcrumbSeparator::new())
        .child(BreadcrumbItem::new().child(BreadcrumbPage::new().child(copy.title)));
    Breadcrumb::new(copy.breadcrumb)
        .child(list)
        .into_any_element()
}
