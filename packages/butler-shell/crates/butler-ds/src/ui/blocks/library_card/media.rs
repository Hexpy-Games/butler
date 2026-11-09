//! What a LibraryCard previews, in the 16:10 slot: a picture (MediaFrame), a quote, a document or
//! a block scrap (rendered live, see `preview`).
use gpui::{
    AnyElement, App, Div, ElementId, ImageSource, IntoElement as _, ParentElement as _,
    SharedString, Styled as _, Window, div, px, relative,
};

use super::preview;
use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::media_frame::{Aspect, MediaFrame};
use crate::ui::tag::{Size as TagSize, Tag};

/// What the card previews: a picture (element crop, page view), a quote (a text scrap), a
/// document or a block (a block scrap, rendered live).
pub enum LibraryCardMedia {
    Image {
        src: ImageSource,
    },
    Quote {
        text: SharedString,
    },
    Document,
    /// The block itself, laid out phone-wide and scaled into the slot. The caller passes
    /// non-interactive content: gpui has no `pointer-events: none` for the React `inert`.
    Block {
        content: AnyElement,
    },
}

/// The slot: a picture on MediaFrame, anything else a matte box holding its preview. The kind
/// `tag` sits on the slot's top corner.
pub(super) fn build(
    id: &ElementId,
    media: LibraryCardMedia,
    tag: Option<&SharedString>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let kind = tag.map(|text| kind_tag(id, text, Ds::get(cx)));
    let tagged = kind.is_some();
    let block = matches!(media, LibraryCardMedia::Block { .. });
    let content = match media {
        LibraryCardMedia::Image { src } => return image(id, src, kind, cx),
        LibraryCardMedia::Quote { text } => quote(text, tagged, Ds::get(cx)),
        LibraryCardMedia::Document => document(tagged, Ds::get(cx)),
        LibraryCardMedia::Block { content } => preview::block(id, content, tagged, window, cx),
    };
    frame(Ds::get(cx), block)
        .child(content)
        .children(kind)
        .into_any_element()
}

/// The matte box of a quote, a document or a group's mosaic (a block sits on the raised surface
/// with a hairline so it reads as the block it is).
pub(crate) fn frame(ds: &Ds, block: bool) -> Div {
    let frame = div()
        .relative()
        .flex()
        .overflow_hidden()
        .w_full()
        .min_w_0()
        .aspect_ratio(Aspect::SixteenTen.ratio())
        .mb(ds.len(Length::SpaceXs))
        .rounded(ds.len(Length::RadiusControl))
        .bg(ds.color(Color::Muted));
    if block {
        return frame
            .bg(ds.color(Color::SurfaceRaised))
            .border(ds.len(Length::BorderHairline))
            .border_color(ds.color(Color::Line));
    }
    frame
}

fn kind_tag(id: &ElementId, text: &SharedString, ds: &Ds) -> AnyElement {
    div()
        .absolute()
        .top(ds.len(Length::SpaceXs))
        .left(ds.len(Length::SpaceXs))
        .child(Tag::new((id.clone(), "kind"), text.clone()).size(TagSize::Sm))
        .into_any_element()
}

fn image(id: &ElementId, src: ImageSource, kind: Option<AnyElement>, cx: &App) -> AnyElement {
    let mut frame = MediaFrame::new((id.clone(), "media")).src(src);
    if kind.is_some() {
        frame = frame.clear_top();
    }
    div()
        .w_full()
        .mb(Ds::get(cx).len(Length::SpaceXs))
        .child(frame.children(kind))
        .into_any_element()
}

/// The room a kind tag takes at the slot's top, which a tagged preview keeps clear.
fn tag_room(ds: &Ds) -> gpui::Pixels {
    ds.len(Length::TagHeightSm) + ds.len(Length::SpaceSm)
}

/// A text scrap previews its words, four lines at most.
fn quote(text: SharedString, tagged: bool, ds: &Ds) -> AnyElement {
    let margin = ds.len(Length::SpaceMd);
    div()
        .flex_1()
        .min_w_0()
        .self_center()
        .m(margin)
        .mt(if tagged { tag_room(ds) } else { margin })
        .text_color(ds.color(Color::TextPrimary))
        .text_size(ds.len(Length::FontSize2))
        .line_height(ds.len(Length::TypoLabelLineHeight))
        .line_clamp(4)
        .child(text)
        .into_any_element()
}

/// A document: a title bar and three lines of text.
fn document(tagged: bool, ds: &Ds) -> AnyElement {
    let bar = |width: f32, height: f32, color: Color| {
        div()
            .w(relative(width))
            .h(px(height))
            .rounded(ds.len(Length::RadiusPill))
            .bg(ds.color(color))
    };
    div()
        .flex()
        .flex_col()
        .w_full()
        .gap(ds.len(Length::SpaceXs) + ds.len(Length::BorderWidthStrong))
        .p(ds.len(Length::SpaceMd))
        .pt(if tagged {
            tag_room(ds)
        } else {
            ds.len(Length::SpaceMd)
        })
        .child(bar(0.6, 9., Color::TextTertiary)) // DS: LibraryCard.module.css:61
        .child(bar(1., 6., Color::LineStrong)) // DS: LibraryCard.module.css:55
        .child(bar(1., 6., Color::LineStrong))
        .child(bar(0.72, 6., Color::LineStrong)) // DS: LibraryCard.module.css:66
        .into_any_element()
}
