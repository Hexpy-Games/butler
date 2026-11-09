//! DS ActivityFeed (ActivityFeed.tsx / ActivityFeed.module.css): a titled list of activity rows,
//! each an optional state icon on the title line, a title with its meta at the end, and a
//! description under it. The transparent surface is the plain bordered panel; the composer
//! surface is the composer's glass. Slots take any element; text passed as a string takes the
//! row's type (title in the label face, description and meta in the caption).
use gpui::{
    AnyElement, App, Div, ElementId, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement, RenderOnce, SharedString, Styled as _, Window, div, px,
};

use crate::tokens::{Color, Length, Number};
use crate::ui::context::Ds;
use crate::ui::layout::{Space, Stack};
use crate::ui::tinted_glass::{GlassPadding, GlassRadius, TintedGlass};

/// One row. `id` keys the row (and its hover state).
pub struct ActivityFeedItem {
    id: SharedString,
    title: AnyElement,
    description: Option<AnyElement>,
    meta: Option<AnyElement>,
    icon: Option<AnyElement>,
}

impl ActivityFeedItem {
    pub fn new(id: impl Into<SharedString>, title: impl IntoElement) -> Self {
        Self {
            id: id.into(),
            title: title.into_any_element(),
            description: None,
            meta: None,
            icon: None,
        }
    }

    pub fn description(mut self, description: impl IntoElement) -> Self {
        self.description = Some(description.into_any_element());
        self
    }

    /// The age or state at the end of the title line.
    pub fn meta(mut self, meta: impl IntoElement) -> Self {
        self.meta = Some(meta.into_any_element());
        self
    }

    /// A state icon sized to the title line.
    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FeedSurface {
    #[default]
    Transparent,
    Composer,
}

#[derive(IntoElement)]
pub struct ActivityFeed {
    id: ElementId,
    items: Vec<ActivityFeedItem>,
    title: Option<AnyElement>,
    empty_label: AnyElement,
    surface: FeedSurface,
}

impl ActivityFeed {
    pub fn new(id: impl Into<ElementId>, items: Vec<ActivityFeedItem>) -> Self {
        Self {
            id: id.into(),
            items,
            title: None,
            empty_label: SharedString::from("No recent activity").into_any_element(),
            surface: FeedSurface::Transparent,
        }
    }

    pub fn title(mut self, title: impl IntoElement) -> Self {
        self.title = Some(title.into_any_element());
        self
    }

    /// Shown in place of the rows when there are none.
    pub fn empty_label(mut self, label: impl IntoElement) -> Self {
        self.empty_label = label.into_any_element();
        self
    }

    pub fn surface(mut self, surface: FeedSurface) -> Self {
        self.surface = surface;
        self
    }
}

/// `Typo.Caption` in the feed's tertiary regular face (description, meta, empty label).
fn caption(child: AnyElement, ds: &Ds) -> Div {
    div()
        .text_size(ds.len(Length::TypoCaptionSize))
        .line_height(ds.len(Length::TypoCaptionLineHeight))
        .font_weight(FontWeight(ds.number(Number::FontWeightRegular)))
        .text_color(ds.color(Color::TextTertiary))
        .child(child)
}

/// `Typo.PanelSectionTitle` in the primary tone.
fn feed_title(child: AnyElement, ds: &Ds) -> Div {
    div()
        .text_size(ds.len(Length::TypoPanelSectionTitleSize))
        .line_height(ds.len(Length::TypoPanelSectionTitleLineHeight))
        .font_weight(FontWeight(ds.number(Number::TypoPanelSectionTitleWeight)))
        .text_color(ds.color(Color::TextPrimary))
        .child(child)
}

/// The row's title: `Typo.Body` at the label size, one line, ellipsised.
fn item_title(child: AnyElement, ds: &Ds) -> Div {
    div()
        .min_w_0()
        .flex_shrink(1.)
        .overflow_hidden()
        .whitespace_nowrap()
        .text_ellipsis()
        .text_size(ds.len(Length::FontSize2))
        .line_height(ds.len(Length::TypoLabelLineHeight))
        .font_weight(FontWeight(ds.number(Number::FontWeightRegular)))
        .text_color(ds.color(Color::TextPrimary))
        .child(child)
}

fn row(feed: &ElementId, item: ActivityFeedItem, ds: &Ds) -> AnyElement {
    let header = div()
        .flex()
        .items_start()
        .justify_between()
        .gap(ds.len(Length::SpaceSm))
        .min_w_0()
        .child(item_title(item.title, ds))
        .children(
            item.meta
                .map(|meta| div().flex_none().child(caption(meta, ds))),
        );
    let body = Stack::new()
        .gap(Space::Xs)
        .child(header)
        .children(item.description.map(|text| caption(text, ds)));
    // The icon box is one title line square (`1lh`), so it sits on the title's line.
    let icon = item.icon.map(|icon| {
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(ds.len(Length::TypoLabelLineHeight))
            .text_size(ds.len(Length::FontSize2))
            .text_color(ds.color(Color::TextTertiary))
            .child(icon)
    });
    div()
        .id((feed.clone(), item.id))
        .flex()
        .items_start()
        .gap(ds.len(Length::Space2))
        .py(px(3.)) // DS: ActivityFeed.module.css:20
        .px(ds.len(Length::Space1))
        .rounded(ds.len(Length::RadiusControl))
        .hover_style(|style| style.bg(ds.color(Color::Selection)))
        .children(icon)
        .child(div().flex_1().min_w_0().child(body))
        .into_any_element()
}

impl RenderOnce for ActivityFeed {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let content = if self.items.is_empty() {
            caption(self.empty_label, ds).into_any_element()
        } else {
            Stack::new()
                .gap(Space::Xs)
                .children(self.items.into_iter().map(|item| row(&self.id, item, ds)))
                .into_any_element()
        };
        let stack = Stack::new()
            .gap(Space::Sm)
            .children(self.title.map(|title| feed_title(title, ds)))
            .child(content);
        let padded = div()
            .w_full()
            .min_w_0()
            .px(ds.len(Length::SpaceSm))
            .py(ds.len(Length::SpaceXs))
            .text_color(ds.color(Color::TextPrimary))
            .child(stack);
        match self.surface {
            FeedSurface::Composer => TintedGlass::new()
                .radius(GlassRadius::Composer)
                .padding(GlassPadding::None)
                .child(padded)
                .into_any_element(),
            FeedSurface::Transparent => div()
                .w_full()
                .min_w_0()
                .border(px(1.)) // DS: SurfacePanel.module.css:5
                .border_color(ds.color(Color::Line))
                .rounded(ds.len(Length::RadiusControl))
                .child(padded)
                .into_any_element(),
        }
    }
}
