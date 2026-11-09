//! The composer card's window rect, for the new chat's wallpaper (React's `contentRect2`).
//! gpui knows a box's place only while painting, so the card's probe records it here.
use butler_ds::ui::blocks::prompt_suggestion_list::ContentRect;
use gpui::{App, Bounds, Global, Pixels};

#[derive(Default)]
struct CardRect(Option<ContentRect>);

impl Global for CardRect {}

/// The card's rect as last painted.
pub(crate) fn card_rect(cx: &App) -> Option<ContentRect> {
    cx.try_global::<CardRect>().and_then(|card| card.0)
}

/// Stores the card's bounds; true when they changed.
pub(super) fn record(bounds: Bounds<Pixels>, cx: &mut App) -> bool {
    let next = Some(ContentRect {
        x: f32::from(bounds.left()),
        y: f32::from(bounds.top()),
        width: f32::from(bounds.size.width),
        height: f32::from(bounds.size.height),
    });
    if card_rect(cx) == next {
        return false;
    }
    cx.set_global(CardRect(next));
    true
}
