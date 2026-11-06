//! What a drag draws above the tree (NavDropOverlay.tsx): the drop label beside an `Outside`
//! target, the auto-scroll band at the list's edge, and the ghost that follows the pointer.
//! React portals them to `document.body` (the sidebar clips its rows) as `position: fixed`;
//! here they are layers in window coordinates.
use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, Context, IntoElement, ParentElement as _, Pixels, Render, Styled as _,
    Window, div, linear_color_stop, linear_gradient, point, px,
};

use super::auto_scroll::Edge;
use crate::tokens::{Color, Length, Shadow};
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::icon::{IconSize, icon};
use crate::ui::layer::{Layer, Z};
use crate::ui::typo::{Role, Typo};

/// Room the label needs past the row's end before it moves inside the row.
const LABEL_ROOM: f32 = 240.; // DS: NavDropOverlay.tsx:11

/// The label's box: caption line plus `--space-xs` above and below.
pub(super) fn label_height(ds: &Ds) -> f32 {
    f32::from(ds.len(Length::TypoCaptionLineHeight) + ds.len(Length::SpaceXs) * 2.)
}

/// The drop label for an `Outside` payload, beside the row header and above every surface:
/// just past the row's end when there is room, else inside the row's end.
pub(super) fn outside_label(
    text: gpui::SharedString,
    (row, middle): (Bounds<Pixels>, f32),
    invalid: bool,
    window: &Window,
    ds: &Ds,
) -> AnyElement {
    let height = label_height(ds);
    let margin = f32::from(ds.len(Length::SpaceMd));
    let inside = row.right().as_f32() + LABEL_ROOM > window.viewport_size().width.as_f32();
    let fill = ds.color(if invalid {
        Color::ColorDanger
    } else {
        Color::Accent
    });
    let label = div()
        .flex_none()
        .max_w(px(320.).min(window.viewport_size().width * 0.4)) // DS: NavDropTarget.module.css:134
        .overflow_hidden()
        .whitespace_nowrap()
        .text_ellipsis()
        .px(ds.len(Length::SpaceMd))
        .py(ds.len(Length::SpaceXs))
        .rounded(ds.len(Length::RadiusPill))
        .bg(fill)
        .shadow(convert::box_shadows(
            ds.tokens().shadow(Shadow::ShadowCard),
            ds.tokens(),
        ))
        .text_color(ds.color(Color::NeutralWhite))
        .child(Typo::new(Role::Caption, text).tone(crate::ui::typo::Tone::Inherit));
    let y = px(middle - height / 2.);
    let (origin, el) = if inside {
        // `translate(calc(-100% - sm), -50%)`: the label's right edge sits `--space-sm` inside
        // the row's end.
        let lane = div()
            .flex()
            .justify_end()
            .w(row.size.width)
            .pr(ds.len(Length::SpaceSm))
            .child(label);
        (point(row.left(), y), lane.into_any_element())
    } else {
        (
            point(row.right() + px(margin), y),
            div().flex().child(label).into_any_element(),
        )
    };
    Layer::new(Z::Drag, origin, el).into_any_element()
}

/// The auto-scroll band: the list's 40px edge zone with the direction of travel.
pub(super) fn scroll_band(edge: Edge, list: Bounds<Pixels>, ds: &Ds) -> AnyElement {
    let height = ds.len(Length::Space4xl);
    let accent = ds.color(Color::Accent);
    let (angle, top, turn) = match edge {
        Edge::End => (0., list.bottom() - height, 0.),
        Edge::Start => (180., list.top(), std::f32::consts::PI),
    };
    let tint = linear_color_stop(convert::with_alpha(accent, 0.22), 0.); // DS: NavDropTarget.module.css:160
    let clear = linear_color_stop(gpui::transparent_black(), 1.);
    let band = div()
        .flex()
        .items_center()
        .justify_center()
        .w(list.size.width)
        .h(height)
        .bg(linear_gradient(angle, tint, clear))
        .text_color(ds.color(Color::AccentText))
        .child(icon(Icon::ChevronDown, IconSize::Md, ds).turned(turn));
    Layer::new(Z::Drag, point(list.left(), top), band).into_any_element()
}

/// What draws the view that follows the pointer.
pub(super) type Ghosting = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;

/// The view that follows the pointer while a row is dragged.
pub(super) struct Ghost(pub(super) Ghosting);

impl Render for Ghost {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().child((self.0)(window, cx))
    }
}
