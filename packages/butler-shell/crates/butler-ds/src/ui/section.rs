//! DS Section (Section.tsx / Section.module.css): a region with an optional title row (icon,
//! title, actions on the right) and description above its content.
use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement, RenderOnce,
    SharedString, Styled as _, Window, div,
};

use crate::tokens::Color;
use crate::ui::context::Ds;
use crate::ui::layout::{Cross, Justify, MinWidth, Space, Stack, WithItem as _};
use crate::ui::strut;
use crate::ui::typo::{Tone, Typo};

#[derive(IntoElement)]
pub struct Section {
    id: ElementId,
    title: Option<AnyElement>,
    icon: Option<AnyElement>,
    description: Option<SharedString>,
    actions: Option<AnyElement>,
    gap: Space,
    header_gap: Space,
    fill: bool,
    content_fill: bool,
    children: Vec<AnyElement>,
}

impl Section {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            title: None,
            icon: None,
            description: None,
            actions: None,
            gap: Space::Md,
            header_gap: Space::Sm,
            fill: false,
            content_fill: false,
            children: Vec::new(),
        }
    }

    /// The title text, in the panel section title role.
    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(
            Typo::panel_section_title(title)
                .tone(Tone::Primary)
                .min_width(MinWidth::Zero)
                .into_any_element(),
        );
        self
    }

    /// A title that is its own element (React passes `<Typo.PanelTitle>`).
    pub fn title_element(mut self, title: impl IntoElement) -> Self {
        self.title = Some(title.into_any_element());
        self
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn actions(mut self, actions: impl IntoElement) -> Self {
        self.actions = Some(actions.into_any_element());
        self
    }

    /// The gap between the content's children.
    pub fn gap(mut self, gap: Space) -> Self {
        self.gap = gap;
        self
    }

    /// The gap between the title row and the description.
    pub fn header_gap(mut self, gap: Space) -> Self {
        self.header_gap = gap;
        self
    }

    /// Take the height of the parent (`height: 100%; min-height: 0`).
    pub fn fill(mut self) -> Self {
        self.fill = true;
        self
    }

    /// The content takes the room the header leaves (`flex: 1 1 auto; min-height: 0`).
    pub fn content_fill(mut self) -> Self {
        self.content_fill = true;
        self
    }
}

impl ParentElement for Section {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl Section {
    /// The title row: icon and title on the left, actions on the right.
    fn title_row(&mut self, ds: &Ds) -> Option<AnyElement> {
        let (title, icon, actions) = (self.title.take(), self.icon.take(), self.actions.take());
        if title.is_none() && icon.is_none() && actions.is_none() {
            return None;
        }
        let icon = icon.map(|icon| {
            div()
                .flex()
                .flex_none()
                .text_color(ds.color(Color::TextSecondary))
                .child(icon)
        });
        let group = (title.is_some() || icon.is_some()).then(|| {
            Stack::row()
                .gap(Space::Sm)
                .cross(Cross::Center)
                .min_width(MinWidth::Zero)
                .children(icon)
                .children(title)
        });
        let actions = actions.map(|actions| {
            Stack::row()
                .gap(Space::Sm)
                .cross(Cross::Center)
                .shrink(false)
                .child(actions)
        });
        Some(
            Stack::row()
                .gap(Space::Md)
                .justify(Justify::Between)
                .cross(Cross::Center)
                .min_width(MinWidth::Zero)
                .children(group)
                .children(actions)
                .into_any_element(),
        )
    }
}

impl RenderOnce for Section {
    fn render(mut self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let row = self.title_row(ds);
        let description = self
            .description
            .take()
            .map(|text| Typo::body(text).tone(Tone::Secondary));
        let header = (row.is_some() || description.is_some()).then(|| {
            Stack::new()
                .gap(self.header_gap)
                .min_width(MinWidth::Zero)
                .children(row)
                .children(description)
        });
        let mut content = Stack::new()
            .gap(self.gap)
            .min_width(MinWidth::Zero)
            .children(std::mem::take(&mut self.children));
        if self.content_fill {
            content = content.fill();
        }
        let mut root = Stack::new()
            .gap(Space::Lg)
            .min_width(MinWidth::Zero)
            .children(header)
            .child(content);
        let mut frame = div().id(self.id).flex().flex_col().min_w_0();
        if self.fill {
            root = root.fill();
            frame = frame.h_full().min_h_0();
        }
        strut::flex_scope(false, frame.child(root))
    }
}
