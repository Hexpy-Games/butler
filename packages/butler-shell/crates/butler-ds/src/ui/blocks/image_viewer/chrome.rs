//! The pieces of the viewer's surface: the bar, the side buttons, the caption, the picture on the
//! stage and the geometry of a pointer over it.
use gpui::{
    AnyElement, Bounds, ElementId, Entity, InteractiveElement as _, IntoElement, MouseButton,
    ObjectFit, ParentElement, Pixels, Point, Size, Styled as _, StyledImage as _, div, img, px,
};

use super::surface::ImageViewerSurface;
use super::zoom::{MAX_ZOOM, MIN_ZOOM, View, ZOOM_STEP, clamp, zoom_at};
use super::{Handler, ViewerImage, ViewerLabels};
use crate::tokens::{Color, Length, Shadow};
use crate::ui::Icon;
use crate::ui::button;
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::icon::{IconSize, icon};
use crate::ui::icon_button::IconButton;
use crate::ui::icon_slot::{IconSlot, SlotSize, SlotTone};
use crate::ui::media_frame::Load;
use crate::ui::tinted_glass::{GlassPadding, GlassRadius, TintedGlass};
use crate::ui::typo::{Tone, Typo};

/// The fitted size of a picture of `natural` size in `stage`: never upscaled.
pub(super) fn fitted(natural: (f32, f32), stage: (f32, f32)) -> (f32, f32) {
    let (nw, nh) = natural;
    let scale = (stage.0 / nw).min(stage.1 / nh).min(1.);
    (nw * scale, nh * scale)
}

pub(super) fn capsule() -> TintedGlass {
    TintedGlass::new()
        .radius(GlassRadius::Control)
        .padding(GlassPadding::None)
}

/// A press on a control or the picture never closes the viewer.
pub(super) fn own(part: gpui::Div) -> gpui::Div {
    part.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
}

/// What the bar needs: the zoom buttons' state and the container's pieces.
pub(super) struct Chrome<'a> {
    pub(super) surface: &'a ImageViewerSurface,
    pub(super) view: &'a Entity<View>,
    pub(super) current: View,
}

/// The zoom buttons (when their labels are given), disabled at the ends of the range.
fn zoom_buttons(chrome: &Chrome, ds: &Ds) -> crate::ui::layout::Stack {
    let (id, labels) = (&chrome.surface.id, &chrome.surface.labels);
    let mut tools = button::container(button::Size::IconSm);
    for (key, label, enabled, factor, glyph) in [
        (
            "zoom-out",
            &labels.zoom_out,
            chrome.current.scale > MIN_ZOOM,
            1. / ZOOM_STEP,
            Icon::ZoomOut,
        ),
        (
            "zoom-in",
            &labels.zoom_in,
            chrome.current.scale < MAX_ZOOM,
            ZOOM_STEP,
            Icon::ZoomIn,
        ),
    ] {
        let Some(label) = label else { continue };
        let state = chrome.view.clone();
        let mut zoom = IconButton::new((id.clone(), key), label.clone())
            .icon(icon(glyph, IconSize::Sm, ds))
            .on_click(move |_, _, cx| {
                state.update(cx, |view, cx| {
                    let to = (view.scale * factor).clamp(MIN_ZOOM, MAX_ZOOM);
                    *view = zoom_at(*view, to, (0., 0.));
                    cx.notify();
                });
            });
        if !enabled {
            zoom = zoom.disabled();
        }
        tools = tools.child(zoom);
    }
    tools
}

pub(super) fn bar(chrome: &Chrome, actions: Vec<AnyElement>, ds: &Ds) -> gpui::Div {
    let surface = chrome.surface;
    let (index, total) = surface.position;
    let (id, labels) = (&surface.id, &surface.labels);
    let min_height = px(36.); // DS: ImageViewer.module.css:76
    let pad = ds.len(Length::Space2);
    let tools = zoom_buttons(chrome, ds);
    let tools = actions.into_iter().fold(tools, gpui::ParentElement::child);
    let mut close = IconButton::new((id.clone(), "close"), labels.close.clone()).icon(icon(
        Icon::X,
        IconSize::Sm,
        ds,
    ));
    if let Some(on_close) = surface.on_close.clone() {
        close = close.on_click(move |_, window, cx| on_close(window, cx));
    }
    let position = (total > 1).then(|| {
        own(div()).child(
            capsule().child(
                div()
                    .flex()
                    .items_center()
                    .min_h(min_height)
                    .px(pad)
                    .child(Typo::caption(format!("{} / {total}", index + 1)).tabular()),
            ),
        )
    });
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap(pad)
        .child(div().children(position))
        .child(
            own(div()).child(
                capsule().child(
                    div()
                        .flex()
                        .items_center()
                        .min_h(min_height)
                        .px(pad)
                        .child(tools.child(close)),
                ),
            ),
        )
}

pub(super) fn nav(
    id: &ElementId,
    side: &'static str,
    label: &gpui::SharedString,
    glyph: Icon,
    handler: Option<Handler>,
    ds: &Ds,
) -> gpui::Div {
    let mut button = IconButton::new((id.clone(), side), label.clone())
        .icon(icon(glyph, IconSize::Sm, ds).turned(0.));
    button = match handler {
        Some(handler) => button.on_click(move |_, window, cx| handler(window, cx)),
        None => button.disabled(),
    };
    let wrapper = own(div())
        .absolute()
        .top_0()
        .bottom_0()
        .flex()
        .items_center();
    let wrapper = if side == "previous" {
        wrapper.left_0()
    } else {
        wrapper.right_0()
    };
    wrapper.child(
        TintedGlass::new()
            .radius(GlassRadius::Control)
            .padding(GlassPadding::None)
            .child(div().flex().p(ds.len(Length::Space1)).child(button)),
    )
}

pub(super) fn caption(image: &ViewerImage, ds: &Ds) -> Option<gpui::Div> {
    if image.caption.is_none() && image.source.is_none() {
        return None;
    }
    let mut inner = div()
        .flex()
        .flex_col()
        .max_w(px(640.))
        .min_w_0()
        .gap(ds.len(Length::Space1));
    if let Some(text) = image.caption.clone() {
        inner = inner.child(Typo::text(text).line_clamp(3));
    }
    if let Some(source) = image.source.clone() {
        let label = match &source.checked {
            Some(checked) => format!("{} · {checked}", source.site),
            None => source.site.to_string(),
        };
        let glyph = match source.icon {
            Some(icon_source) => IconSlot::new()
                .size(SlotSize::Md)
                .child(img(icon_source).w(px(16.)).h(px(16.))),
            None => IconSlot::new()
                .size(SlotSize::Md)
                .tone(SlotTone::Tertiary)
                .child(icon(Icon::Globe2, IconSize::Md, ds)),
        };
        inner = inner.child(
            div()
                .flex()
                .items_center()
                .min_w_0()
                .gap(ds.len(Length::Space2))
                .child(glyph)
                .child(
                    div()
                        .min_w_0()
                        .child(Typo::caption(label).tone(Tone::Tertiary).truncate()),
                ),
        );
    }
    Some(
        own(div()).flex().justify_center().child(
            TintedGlass::new()
                .radius(GlassRadius::Control)
                .padding(GlassPadding::Sm)
                .child(inner),
        ),
    )
}

/// The picture on the stage at the view's scale and pan, or the failed message.
pub(super) fn picture(
    image: &ViewerImage,
    labels: &ViewerLabels,
    (stage, view): (Size<Pixels>, View),
    load: &Load,
    ds: &Ds,
) -> Option<AnyElement> {
    match load {
        Load::Pending => None,
        Load::Failed => Some(
            div()
                .absolute()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .child(
                    TintedGlass::new()
                        .radius(GlassRadius::Control)
                        .padding(GlassPadding::Md)
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .items_center()
                                .gap(ds.len(Length::Space2))
                                .text_color(ds.color(Color::TextSecondary))
                                .child(icon(Icon::ImageIcon, IconSize::Xl, ds))
                                .child(Typo::caption(labels.failed.clone()).tone(Tone::Secondary)),
                        ),
                )
                .into_any_element(),
        ),
        Load::Ready(data) => {
            let natural = data.size(0);
            let natural = (natural.width.0 as f32, natural.height.0 as f32);
            let (sw, sh) = (f32::from(stage.width), f32::from(stage.height));
            let (fw, fh) = fitted(natural, (sw, sh));
            let (w, h) = (fw * view.scale, fh * view.scale);
            Some(
                div()
                    .absolute()
                    .left(px((sw - w) / 2. + view.x))
                    .top(px((sh - h) / 2. + view.y))
                    .w(px(w))
                    .h(px(h))
                    .rounded(ds.len(Length::RadiusControl))
                    .shadow(convert::box_shadows(
                        ds.tokens().shadow(Shadow::ShadowCard),
                        ds.tokens(),
                    ))
                    .child(
                        img(image.src.clone())
                            .size_full()
                            .rounded(ds.len(Length::RadiusControl))
                            .object_fit(ObjectFit::Fill),
                    )
                    .into_any_element(),
            )
        }
    }
}

/// A window point as an offset from the stage's centre.
pub(super) fn pointer_offset(position: Point<Pixels>, centre: (f32, f32)) -> (f32, f32) {
    (
        f32::from(position.x) - centre.0,
        f32::from(position.y) - centre.1,
    )
}

/// The view kept over the fitted picture's box.
pub(super) fn fit_clamp(view: View, natural: Option<(f32, f32)>, stage: Bounds<Pixels>) -> View {
    let Some(natural) = natural else { return view };
    let (w, h) = fitted(
        natural,
        (f32::from(stage.size.width), f32::from(stage.size.height)),
    );
    clamp(view, w, h)
}
