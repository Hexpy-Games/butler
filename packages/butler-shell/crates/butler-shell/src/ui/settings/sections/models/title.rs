//! The header line of the add, edit and management routes (`ModelSettingsTitle.tsx`): Back and
//! the trail "Models > Model management > page". At the root there is none.
use std::rc::Rc;

use butler_ds::ui::blocks::breadcrumb::{
    Breadcrumb, BreadcrumbButton, BreadcrumbItem, BreadcrumbList, BreadcrumbPage,
    BreadcrumbSeparator,
};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Cross, Space, Stack};
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

/// The section's subpage for a route; `None` at the root.
pub(super) fn subpage(route: &ModelRoute, navigate: Navigate) -> Option<Subpage> {
    let (key, page) = match route {
        ModelRoute::Root => return None,
        ModelRoute::Management => ("models/management", Page::Management),
        ModelRoute::Add => ("models/add", Page::Add),
        ModelRoute::Edit(_) => ("models/edit", Page::Edit),
    };
    Some(Subpage {
        key: key.into(),
        secondary: Rc::new(move |_, cx| trail(page, &navigate, cx)),
    })
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

fn trail(page: Page, navigate: &Navigate, cx: &App) -> AnyElement {
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
    Stack::row()
        .cross(Cross::Center)
        .gap(Space::Sm)
        .child(back)
        .child(Breadcrumb::new(words.breadcrumb).child(list))
        .into_any_element()
}
