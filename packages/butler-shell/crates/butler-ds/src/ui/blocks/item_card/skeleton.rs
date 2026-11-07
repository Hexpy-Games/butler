//! DS ItemCardSkeleton (ItemCardSkeleton.tsx): the loading shape of an ItemCard, on the same
//! card, tracks and width rule: the picture box at the set's aspect, three text lines (subtitle,
//! title, facts) and the footer line at the actions' height, so a skeleton that becomes that
//! card shifts nothing. The footer keeps one invisible IconButton for the height.
use gpui::{
    App, ElementId, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _, Window, div,
    px,
};

use super::{ROW_FROM, ROW_MEDIA};
use crate::tokens::{Color, Length, Number};
use crate::ui::blocks::measure;
use crate::ui::button::{self, Size};
use crate::ui::context::Ds;
use crate::ui::icon_button::IconButton;
use crate::ui::layout::Space;
use crate::ui::media_frame::Aspect;
use crate::ui::skeleton::{Height, Skeleton, Width};

#[derive(IntoElement)]
pub struct ItemCardSkeleton {
    id: ElementId,
    media: Option<Aspect>,
    label: Option<SharedString>,
}

impl ItemCardSkeleton {
    /// A picture box of the set's aspect (1:1 by default).
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            media: Some(Aspect::Square),
            label: None,
        }
    }

    /// The picture's aspect; `None` for cards without a picture.
    pub fn media(mut self, media: Option<Aspect>) -> Self {
        self.media = media;
        self
    }

    /// An accessible loading label.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }
}

/// One text line: a box of the role's line height with a bar centred in it.
fn line(id: (ElementId, &'static str), width: Width, height: Height, box_height: f32) -> gpui::Div {
    div()
        .flex()
        .items_center()
        .min_w_0()
        .h(px(box_height))
        .child(Skeleton::new(id).width(width).height(height))
}

/// The footer line: the source bar and one invisible IconButton that holds the actions' height.
fn footer(id: &ElementId, row: bool, ds: &Ds) -> gpui::Div {
    div()
        .flex()
        .items_center()
        .gap(ds.len(Length::SpaceXs))
        .pt(ds.len(Length::SpaceXs))
        .pl(ds.len(Length::SpaceXs))
        .border_t(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .child(
            div().flex_1().min_w_0().child(
                Skeleton::new((id.clone(), "source"))
                    .width(Width::Half)
                    .height(Height::Line),
            ),
        )
        .child(
            div().flex_none().child(
                button::container(Size::IconSm)
                    .gap(if row { Space::Sm } else { Space::Xs })
                    .child(
                        // A flex item, as in the card's actions: a block box would add a line box.
                        div()
                            .flex()
                            .invisible()
                            .child(IconButton::new((id.clone(), "action"), "")),
                    ),
            ),
        )
}

/// The three text lines (subtitle, title, facts) of the body.
fn text_lines(
    id: &ElementId,
    (caption, title, facts): (f32, f32, f32),
    inset: gpui::Pixels,
    ds: &Ds,
) -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .gap(ds.len(Length::SpaceXs))
        .px(inset)
        .child(line(
            (id.clone(), "subtitle"),
            Width::TwoFifths,
            Height::Line,
            caption,
        ))
        .child(line(
            (id.clone(), "title"),
            Width::ThreeQuarters,
            Height::Title,
            title,
        ))
        .child(line(
            (id.clone(), "facts"),
            Width::TwoThirds,
            Height::Line,
            facts,
        ))
}

impl RenderOnce for ItemCardSkeleton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (size, recorder) = measure::track((self.id.clone(), "size"), window, cx);
        let row = f32::from(size.width) >= ROW_FROM;
        let ds = Ds::get(cx);
        let body_line = ds.number(Number::LineHeightBody);
        // `.skeletonLine` computes the subtitle box as `calc(<length> * <length>)`, which is
        // invalid CSS, so that box is as tall as its bar (`--skeleton-height-line`).
        let caption_line = f32::from(ds.len(Length::SkeletonHeightLine));
        let title_line = f32::from(ds.len(Length::FontSize3)) * body_line;
        let facts_line = f32::from(ds.len(Length::FontSize1)) * body_line;
        let id = self.id.clone();
        let inset = if row && self.media.is_some() {
            px(0.)
        } else {
            ds.len(Length::SpaceXs)
        };
        let body = text_lines(&id, (caption_line, title_line, facts_line), inset, ds);
        let media = self.media.map(|aspect| {
            div()
                .min_w_0()
                .child(Skeleton::new((id.clone(), "media")).aspect(aspect.ratio()))
        });
        let gap = ds.len(Length::SpaceSm);
        let top = if row {
            let mut top = div().flex().flex_1().gap(ds.len(Length::SpaceMd));
            if let Some(media) = media {
                top = top.child(div().flex_none().w(px(ROW_MEDIA)).child(media));
            }
            top.child(body)
        } else {
            div()
                .flex()
                .flex_col()
                .flex_1()
                .gap(gap)
                .children(media)
                .child(body)
        };
        let footer = footer(&id, row, ds);
        div()
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .child(recorder)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(gap)
                    .p(ds.len(Length::Space2))
                    .border(ds.len(Length::BorderHairline))
                    .border_color(ds.color(Color::Line))
                    .rounded(ds.len(Length::RadiusControl))
                    .bg(ds.color(Color::SurfaceRaised))
                    .child(top)
                    .child(footer),
            )
    }
}
