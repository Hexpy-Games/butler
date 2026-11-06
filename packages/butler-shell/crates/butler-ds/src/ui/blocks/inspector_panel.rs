//! DS InspectorPanel and InspectorInset (InspectorPanel.tsx, InspectorInset.tsx,
//! InspectorPanel.module.css): a titled section card for the inspector column, and the inset
//! that lines other full-width content up with those cards.
use gpui::{
    AnyElement, App, IntoElement, ParentElement as _, Pixels, RenderOnce, SharedString,
    Styled as _, Window, div, px,
};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::layout::{Cross, Justify, MinWidth, Space, Stack, WithItem as _};
use crate::ui::strut;
use crate::ui::typo::{Tone, Typo};

/// `color-mix(in srgb, var(--surface-raised) 88%, transparent)` of the card.
const CARD_SHARE: f32 = 0.88; // DS: InspectorPanel.module.css:6

#[derive(IntoElement)]
pub struct InspectorPanel {
    title: SharedString,
    description: Option<SharedString>,
    icon: Option<AnyElement>,
    action: Option<AnyElement>,
    inline_padding: Pixels,
    children: Vec<AnyElement>,
}

impl InspectorPanel {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            description: None,
            icon: None,
            action: None,
            inline_padding: px(0.),
            children: Vec::new(),
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.action = Some(action.into_any_element());
        self
    }

    /// `--inspector-inline-padding`: the inspector column's inline padding the card is inset by.
    pub fn inline_padding(mut self, padding: Pixels) -> Self {
        self.inline_padding = padding;
        self
    }
}

impl gpui::ParentElement for InspectorPanel {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// Section's header: icon and title on one row with the actions at the end, the description
/// under it (Section.tsx; the title is a `PanelSectionTitle`, the description a `Body`).
fn header(panel: &mut InspectorPanel) -> AnyElement {
    let title = Stack::row()
        .cross(Cross::Center)
        .gap(Space::Sm)
        .min_width(MinWidth::Zero)
        .children(
            panel
                .icon
                .take()
                .map(|icon| div().flex().flex_none().child(icon)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .child(Typo::panel_section_title(panel.title.clone()).tone(Tone::Primary)),
        );
    let row = Stack::row()
        .justify(Justify::Between)
        .cross(Cross::Center)
        .gap(Space::Md)
        .min_width(MinWidth::Zero)
        .child(title)
        .children(panel.action.take().map(|action| {
            Stack::row()
                .cross(Cross::Center)
                .gap(Space::Sm)
                .shrink(false)
                .child(action)
        }));
    Stack::new()
        .gap(Space::Sm)
        .min_width(MinWidth::Zero)
        .child(row)
        .children(
            panel
                .description
                .take()
                .map(|text| Typo::body(text).tone(Tone::Secondary)),
        )
        .into_any_element()
}

impl RenderOnce for InspectorPanel {
    fn render(mut self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let header = header(&mut self);
        let section = Stack::new()
            .gap(Space::Lg)
            .min_width(MinWidth::Zero)
            .child(header)
            .child(
                Stack::new()
                    .gap(Space::Sm)
                    .min_width(MinWidth::Zero)
                    .child(Stack::new().gap(Space::Sm).children(self.children)),
            );
        let surface = convert::with_alpha(ds.color(Color::SurfaceRaised), CARD_SHARE);
        strut::scope(
            true,
            div()
                .min_w_0()
                .mx(self.inline_padding)
                .p(ds.len(Length::SpaceMd))
                .border(px(1.)) // DS: InspectorPanel.module.css:5
                .border_color(ds.color(Color::Line))
                .rounded(ds.len(Length::RadiusPanel))
                .bg(surface)
                .text_color(ds.color(Color::TextPrimary))
                .child(section),
        )
    }
}

/// Insets full-width inspector content by the inspector's inline padding; `fill` lets it take
/// the remaining height of the inspector column.
#[derive(IntoElement)]
pub struct InspectorInset {
    inline_padding: Pixels,
    fill: bool,
    children: Vec<AnyElement>,
}

impl InspectorInset {
    pub fn new() -> Self {
        Self {
            inline_padding: px(0.),
            fill: false,
            children: Vec::new(),
        }
    }

    pub fn fill(mut self) -> Self {
        self.fill = true;
        self
    }

    pub fn inline_padding(mut self, padding: Pixels) -> Self {
        self.inline_padding = padding;
        self
    }
}

impl Default for InspectorInset {
    fn default() -> Self {
        Self::new()
    }
}

impl gpui::ParentElement for InspectorInset {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for InspectorInset {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let el = div().min_w_0().px(self.inline_padding);
        let el = if self.fill {
            el.flex().flex_auto().flex_col().min_h_0()
        } else {
            el
        };
        el.children(self.children)
    }
}
