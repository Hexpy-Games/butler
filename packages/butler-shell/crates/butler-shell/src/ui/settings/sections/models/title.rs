//! The header line of the models routes (`ModelSettingsTitle.tsx`): Back and the trail
//! "Models > Model management > page". At the root the line keeps its room but is hidden
//! (`invisible={hidden}`), so the page starts at the same height on every route.
use std::rc::Rc;

use butler_ds::ui::blocks::breadcrumb::{
    Breadcrumb, BreadcrumbButton, BreadcrumbItem, BreadcrumbList, BreadcrumbPage,
    BreadcrumbSeparator,
};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Cross, Space, Stack, WithItem as _};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _};

use super::root::copy;
use super::{ModelRoute, Navigate};
use crate::ui::Icon;
use crate::ui::i18n::settings::words as frame_words;
use crate::ui::settings::Subpage;
use crate::ui::settings::sections::SectionId;

/// Which route page the trail names.
#[derive(Clone, Copy, PartialEq)]
enum Page {
    Management,
    Add,
    Edit,
}

impl Page {
    /// `backModelRoute`: add and edit go back to management, management to the root.
    fn parent(self) -> ModelRoute {
        match self {
            Self::Management => ModelRoute::Root,
            Self::Add | Self::Edit => ModelRoute::Management,
        }
    }
}

/// The section's header line for a route. React keys the page by the section alone
/// (`pageKey={activeSection}`), so every route keeps the `models` key.
pub(super) fn subpage(route: &ModelRoute, navigate: Navigate) -> Subpage {
    // `pageTitle`: the root falls through to the add title, hidden.
    let (page, hidden) = match route {
        ModelRoute::Root => (Page::Add, true),
        ModelRoute::Management => (Page::Management, false),
        ModelRoute::Add => (Page::Add, false),
        ModelRoute::Edit(_) => (Page::Edit, false),
    };
    Subpage {
        key: SectionId::Models.id().into(),
        secondary: Rc::new(move |_, cx| trail(page, hidden, &navigate, cx)),
    }
}

/// A trail step that goes to `route`.
fn step(
    id: &'static str,
    label: &'static str,
    route: ModelRoute,
    navigate: &Navigate,
) -> BreadcrumbItem {
    let navigate = navigate.clone();
    BreadcrumbItem::new().child(
        BreadcrumbButton::new(id)
            .child(label)
            .on_click(move |_, window, cx| navigate(route.clone(), window, cx)),
    )
}

fn trail(page: Page, hidden: bool, navigate: &Navigate, cx: &App) -> AnyElement {
    let lang = Ds::get(cx).lang();
    let words = copy::words(lang);
    let models = SectionId::Models.copy(lang).label;
    let title = match page {
        Page::Management => words.management_title,
        Page::Edit => words.edit_title,
        Page::Add => words.add_title,
    };
    let back = {
        let navigate = navigate.clone();
        IconButton::new("settings-model-back", frame_words(lang).back)
            .glyph(Icon::ArrowLeft)
            .on_click(move |_, window, cx| navigate(page.parent(), window, cx))
    };
    let mut list = BreadcrumbList::new().child(step(
        "models-crumb-root",
        models,
        ModelRoute::Root,
        navigate,
    ));
    if page != Page::Management {
        list = list.child(BreadcrumbSeparator::new()).child(step(
            "models-crumb-management",
            words.management_title,
            ModelRoute::Management,
            navigate,
        ));
    }
    let list = list
        .child(BreadcrumbSeparator::new())
        .child(BreadcrumbItem::new().child(BreadcrumbPage::new().child(title)));
    let line = Stack::row()
        .cross(Cross::Center)
        .gap(Space::Sm)
        .child(back)
        .child(Breadcrumb::new(words.breadcrumb).child(list));
    if hidden { line.invisible() } else { line }.into_any_element()
}
