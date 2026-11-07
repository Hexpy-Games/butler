//! Square attachment tiles (AttachmentTiles.tsx / AttachmentTileFace.tsx / AttachmentTiles.module.css):
//! a picture's cover thumbnail or the file's face (glyph, type label, name, size), with a remove
//! dot on hover or focus. `row` is 64px in one sideways-scrolling row (composer), `wrap` 96px
//! and wrapping (a sent message). The tile's enter and exit motion and the slide into a gap
//! are not reproduced.
use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ObjectFit, ParentElement,
    SharedString, StatefulInteractiveElement as _, Styled as _, StyledImage as _, Window, div, img,
    px,
};

use super::{AttachmentItem, AttachmentList, ThumbnailFit, TileAlign, TileLayout, Upload};
use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::button::{Button, Size, Variant as ButtonVariant};
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon};
use crate::ui::spinner::Spinner;
use crate::ui::tooltip::Tooltip;
use crate::ui::typo::{Tone, Typo, Weight, Wrap};

const ROW_SIZE: f32 = 64.; // DS: AttachmentTiles.module.css:4
const WRAP_SIZE: f32 = 96.; // DS: AttachmentTiles.module.css:13
const REMOVE_SIZE: f32 = 20.; // DS: AttachmentTiles.module.css:213

/// The file face: glyph and type label, the name on two lines, the size on a message tile.
fn file_face(item: &AttachmentItem, wrap: bool, ds: &Ds) -> AnyElement {
    let danger = item.upload == Some(Upload::Failed);
    let blocked = item.blocked_reason.is_some();
    let head_color = if danger {
        Color::Danger
    } else if blocked {
        Color::InteractiveDisabledFg
    } else {
        Color::TextTertiary
    };
    let glyph = match item.upload {
        Some(Upload::Uploading) => Spinner::new((ElementId::from(item.id.clone()), "spin"))
            .size(14.)
            .into_any_element(),
        Some(Upload::Failed) => icon(Icon::AlertCircle, IconSize::Sm, ds).into_any_element(),
        None => icon(item.icon.unwrap_or(Icon::FileText), IconSize::Sm, ds).into_any_element(),
    };
    let head = div()
        .flex()
        .items_center()
        .min_w_0()
        .gap(if wrap {
            ds.len(Length::SpaceXs)
        } else {
            px(2.)
        })
        .text_color(ds.color(head_color))
        .child(glyph)
        .children(item.extension.clone().map(|extension| {
            div()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(
                    Typo::caption(extension)
                        .weight(Weight::Semibold)
                        .tone(Tone::Inherit),
                )
        }));
    let name_tone = if blocked {
        Tone::Disabled
    } else {
        Tone::Primary
    };
    let mut face = div()
        .flex()
        .flex_col()
        .size_full()
        .gap(ds.len(Length::SpaceXs))
        .p(if wrap {
            ds.len(Length::SpaceSm)
        } else {
            px(6.)
        })
        .child(head)
        .child(
            div().min_w_0().child(
                Typo::caption(item.name.clone())
                    .tone(name_tone)
                    .line_clamp(2)
                    .wrap(Wrap::Anywhere),
            ),
        );
    if let (true, Some(meta)) = (wrap, item.meta.clone()) {
        face = face.child(
            div().flex_1().flex().items_end().min_w_0().child(
                Typo::caption(meta)
                    .tone(Tone::Tertiary)
                    .tabular()
                    .truncate(),
            ),
        );
    }
    face.into_any_element()
}

/// The tile's face: the cover picture, or the file face.
fn face(item: &AttachmentItem, wrap: bool, ds: &Ds) -> AnyElement {
    let Some((src, fit)) = item.thumbnail.clone() else {
        return file_face(item, wrap, ds);
    };
    let busy = item.upload.is_some();
    let dim = if item.blocked_reason.is_some() {
        0.55
    } else if busy {
        0.45
    } else {
        1.
    };
    let picture = div()
        .size_full()
        .bg(ds.color(Color::Muted))
        .opacity(dim)
        .child(img(src).size_full().object_fit(match fit {
            ThumbnailFit::Cover => ObjectFit::Cover,
            ThumbnailFit::Contain => ObjectFit::Contain,
        }));
    let status = item.upload.map(|status| {
        let side = ds.len(Length::Space3xl);
        let mark = match status {
            Upload::Uploading => Spinner::new((ElementId::from(item.id.clone()), "spin"))
                .size(14.)
                .into_any_element(),
            Upload::Failed => icon(Icon::AlertCircle, IconSize::Sm, ds).into_any_element(),
        };
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(side)
                    .rounded(ds.len(Length::RadiusPill))
                    .bg(ds.color(Color::ComposerGlassControlBg))
                    .text_color(ds.color(if status == Upload::Failed {
                        Color::Danger
                    } else {
                        Color::TextPrimary
                    }))
                    .child(mark),
            )
    });
    div()
        .relative()
        .size_full()
        .child(picture)
        .children(status)
        .into_any_element()
}

/// The remove dot on the tile's corner: shown while the tile is hovered or focused.
fn remove_dot(
    (item, remove, label): (&AttachmentItem, super::Handler, String),
    group: SharedString,
    ds: &Ds,
) -> gpui::Div {
    let id = ElementId::from(item.id.clone());
    let which = item.id.clone();
    let inset = ds.len(Length::SpaceXs);
    div()
        .absolute()
        .top(inset)
        .right(inset)
        .flex()
        .items_center()
        .justify_center()
        .size(px(REMOVE_SIZE))
        .rounded(ds.len(Length::RadiusPill))
        .bg(ds.color(Color::ComposerGlassControlBg))
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .opacity(0.)
        .group_hover_style(group, |style| style.opacity(1.))
        .child(
            Tooltip::new((id.clone(), "remove-tip")).label(label).child(
                Button::new((id, "remove"))
                    .size(Size::IconXs)
                    .variant(ButtonVariant::Borderless)
                    .icon_start(icon(Icon::X, IconSize::Xs, ds))
                    .on_click(move |_, window, cx| remove(&which, window, cx)),
            ),
        )
}

fn tile(item: &AttachmentItem, list: &AttachmentList, wrap: bool, ds: &Ds) -> AnyElement {
    let side = px(if wrap { WRAP_SIZE } else { ROW_SIZE });
    let id = ElementId::from(item.id.clone());
    let group: SharedString = format!("tile-{}", item.id).into();
    let border = if item.upload == Some(Upload::Failed) {
        Color::Danger
    } else {
        Color::Line
    };
    let fill = if wrap {
        Color::SurfaceRaised
    } else {
        Color::ComposerGlassControlBg
    };
    let body = div()
        .relative()
        .size_full()
        .overflow_hidden()
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(border))
        .rounded(ds.len(Length::RadiusPanel))
        .bg(ds.color(fill))
        .child(face(item, wrap, ds));
    let target: AnyElement = match list.on_open.clone() {
        Some(open) => {
            let which = item.id.clone();
            body.id((id.clone(), "face"))
                .cursor_pointer()
                .on_click(move |_, window, cx| open(&which, window, cx))
                .into_any_element()
        }
        None => body.into_any_element(),
    };
    let tip = item
        .blocked_reason
        .clone()
        .unwrap_or_else(|| item.name.clone());
    let anchor = group.to_string();
    let mut tile = div()
        .debug_selector(move || anchor.clone())
        .group(group.clone())
        .relative()
        .flex()
        .flex_none()
        .size(side)
        .child(
            Tooltip::new((id.clone(), "tip"))
                .label(tip)
                .fill()
                .child(div().size_full().child(target)),
        );
    if let Some(remove) = list.on_remove.clone() {
        let label = (list.remove_label)(&item.name);
        tile = tile.child(remove_dot((item, remove, label), group, ds));
    }
    tile.into_any_element()
}

pub(super) fn render(list: &AttachmentList, _: &mut Window, cx: &mut App) -> AnyElement {
    let ds = Ds::get(cx);
    let wrap = list.layout == TileLayout::Wrap;
    let tiles = list.items.iter().map(|item| tile(item, list, wrap, ds));
    if wrap {
        let row = div()
            .flex()
            .flex_wrap()
            .min_w_0()
            .gap(ds.len(Length::SpaceSm))
            .pt(ds.len(Length::SpaceXs))
            .pb(px(2.))
            .children(tiles);
        return match list.align {
            TileAlign::End => row.justify_end(),
            TileAlign::Start => row,
        }
        .into_any_element();
    }
    let track = div()
        .flex()
        .gap(ds.len(Length::SpaceSm))
        .pt(ds.len(Length::FocusRingRoom))
        .px(ds.len(Length::SpaceLg))
        .pb(ds.len(Length::SpaceMd))
        .children(tiles);
    div()
        .id((list.id.clone(), "row"))
        .w_full()
        .min_w_0()
        .overflow_x_scroll()
        .child(track)
        .into_any_element()
}
