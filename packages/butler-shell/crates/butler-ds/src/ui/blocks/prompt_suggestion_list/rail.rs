//! The rail (`.railViewport` and `.grid` of the CSS): the cards in one horizontally scrolling
//! row, edge-faded while clipped (`useScrollEdges("x")`).
//! It reaches up and down by the focus ring's and the card shadow's room and the grid pads it
//! back, so the clip cuts neither.
use gpui::{
    AnyElement, App, ElementId, IntoElement as _, ParentElement as _, SharedString, Styled as _,
    Window, div, px, relative,
};

use super::card::{self, Card};
use super::content_rect::{Recording, Slot};
use super::metrics::Metrics;
use super::{LIFT, PromptSuggestionList};
use crate::tokens::Length;
use crate::ui::context::Ds;
use crate::ui::scroll::{Axis, Config, scroller};

/// The card glass's widest drop shadow: liquid_glass/material.rs `shadow()` at grow = 1
/// (cards >= 200 pt; none exceeds it): Gaussian sigma 16 pt, 8.5 pt down. gpui paints a
/// shadow out to 3 sigma (gpui_render shaders/shadows.rs `shadow_geometry`).
const SHADOW_SIGMA: f32 = 16.;
const SHADOW_DROP: f32 = 8.5;
const GAUSSIAN_CUTOFF: f32 = 3.;

pub(super) fn render(
    list: &PromptSuggestionList,
    m: &Metrics,
    recording: Option<&Recording>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let cards: Vec<AnyElement> = list
        .suggestions
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let id = ElementId::from(SharedString::from(format!("{}-{}", list.id, item.id)));
            card::render(&Card { id, item, index }, m, recording, window, cx)
        })
        .collect();
    let ds = Ds::get(cx);
    // `--prompt-ring-room: focus-ring-room + card-lift`.
    let ring = ds.len(Length::FocusRingRoom) + px(LIFT);
    // Room for the shadow inside the scroller's clip, taken back outside so nothing moves.
    let reach = GAUSSIAN_CUTOFF * SHADOW_SIGMA;
    let (above, below) = (px(reach - SHADOW_DROP), px(reach + SHADOW_DROP));
    let grid = div()
        .flex()
        .flex_row()
        .flex_none()
        .min_w(relative(1.))
        .gap(ds.len(Length::Space4))
        .pt(ring + above)
        .pb(ds.len(Length::Space2) + below)
        .px(px(m.content_inset))
        .children(cards);
    let config = Config {
        id: SharedString::from(format!("{}-rail", list.id)).into(),
        axis: Axis::X,
        size: ds.len(Length::ScrollFadeSize),
        guard: ds.len(Length::SpaceXs),
    };
    let viewport = div().flex().flex_row().w_full().min_w_0().child(grid);
    let built = scroller(&config, viewport, window, cx);
    div()
        .relative()
        .w_full()
        .min_w_0()
        .mt(-(ring + above))
        .mb(-below)
        .overflow_hidden()
        .child(built.element)
        .children(recording.map(|recording| recording.record(Slot::Rail)))
        .into_any_element()
}
