//! DS NavSection (NavSection.tsx / NavSectionHeading.tsx / NavSection.module.css): a titled
//! group of navigation rows, with actions at the title's end. The heading also stands alone
//! over separately scrolling content. Inside a SidebarShell the shell sets the heading inset,
//! aligns headings to the density's action height and pulls the actions to the row edge
//! (SidebarShell.module.css:22-24); outside one the heading takes the DS defaults.
use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _,
    Window, div,
};

pub use super::sidebar_shell::nav as sidebar_nav;

use super::scope::{self, ActionScale, Spec};
use crate::tokens::Length;
use crate::ui::collapsible::{Collapsible, KeepMounted};
use crate::ui::context::Ds;
use crate::ui::layout::{Cross, MinWidth, Space, Stack, WithItem as _};
use crate::ui::typo::{Tone, Typo};

#[derive(IntoElement)]
pub struct NavSectionHeading {
    title: SharedString,
    actions: Option<AnyElement>,
}

impl NavSectionHeading {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            actions: None,
        }
    }

    pub fn actions(mut self, actions: impl IntoElement) -> Self {
        self.actions = Some(actions.into_any_element());
        self
    }
}

impl RenderOnce for NavSectionHeading {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let sidebar = scope::in_density(cx);
        let ds = Ds::get(cx);
        // `--nav-section-heading-inset`, `-min-height` and `--nav-section-actions-edge-offset`.
        let (inset, min_height, edge) = if sidebar {
            (
                ds.len(Length::SpaceXs),
                ds.len(Length::SidebarActionSize),
                -ds.len(Length::SpaceXs),
            )
        } else {
            (ds.len(Length::Space2), gpui::px(0.), gpui::px(0.))
        };
        // `.actions { --icon-button-size: var(--sidebar-action-size) }`
        let scale = Spec {
            action: Some(ActionScale {
                side: f32::from(ds.len(Length::SidebarActionSize)),
                icon: f32::from(ds.len(Length::SidebarIconSize)),
                fixed: false,
            }),
            ..Spec::default()
        };
        let actions = self.actions.map(|actions| {
            div().mr(edge).child(
                Stack::row()
                    .gap(Space::Xs)
                    .cross(Cross::Center)
                    .child(scope::scoped(scale, actions)),
            )
        });
        div()
            .flex()
            .items_center()
            .justify_between()
            .min_w_0()
            .min_h(min_height)
            .px(inset)
            .child(Typo::section_title(self.title).tone(Tone::Tertiary))
            .children(actions)
    }
}

#[derive(IntoElement)]
pub struct NavSection {
    id: ElementId,
    title: SharedString,
    actions: Option<AnyElement>,
    collapsed: bool,
    children: Vec<AnyElement>,
}

impl NavSection {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            actions: None,
            collapsed: false,
            children: Vec::new(),
        }
    }

    /// Buttons at the end of the heading.
    pub fn actions(mut self, actions: impl IntoElement) -> Self {
        self.actions = Some(actions.into_any_element());
        self
    }

    /// Hides the rows and keeps the heading.
    pub fn collapsed(mut self, collapsed: bool) -> Self {
        self.collapsed = collapsed;
        self
    }
}

impl ParentElement for NavSection {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for NavSection {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let mut heading = NavSectionHeading::new(self.title);
        if let Some(actions) = self.actions {
            heading = heading.actions(actions);
        }
        let rows = Collapsible::new((self.id, "rows"), !self.collapsed)
            .keep_mounted(KeepMounted::Hidden)
            .child(Stack::new().gap(Space::Xs).children(self.children));
        Stack::new()
            .gap(Space::Sm)
            .min_width(MinWidth::Zero)
            .child(heading)
            .child(rows)
    }
}
