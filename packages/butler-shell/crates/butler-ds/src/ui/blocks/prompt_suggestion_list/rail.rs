//! The rail (`.railViewport` and `.grid` of the CSS): the cards in one horizontally scrolling
//! row, edge-faded while clipped (`useScrollEdges("x")`). It reaches up by the room a lifted,
//! focused card's ring needs and the grid pads it back, so the clip never cuts the ring.
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
    let grid = div()
        .flex()
        .flex_row()
        .flex_none()
        .min_w(relative(1.))
        .gap(ds.len(Length::Space4))
        .pt(ring)
        .pb(ds.len(Length::Space2))
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
        .mt(-ring)
        .overflow_hidden()
        .child(built.element)
        .children(recording.map(|recording| recording.record(Slot::Rail)))
        .into_any_element()
}
