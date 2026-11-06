//! The list marker of `ul` and `ol` (UA `list-style`, outside): a disc, circle or square by depth,
//! or the number and a dot, right-aligned against the item's text.
use std::sync::Arc;

use gpui::{
    AnyElement, App, FontFeatures, IntoElement as _, ParentElement as _, Styled as _, div, px,
};

use super::{Env, Face};
use crate::ui::context::Ds;

/// The gap between a bullet and the text (`kCMarkerPaddingPx`).
const BULLET_GAP: f32 = 11.;

/// The marker of an item: `number` is `Some` in an ordered list.
pub(super) fn draw(
    number: Option<u64>,
    depth: usize,
    face: Face,
    env: &Env,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let ink = ds.color(env.ink);
    let row = div()
        .flex()
        .justify_end()
        .items_center()
        .h(face.line)
        .w_full()
        .text_color(ink);
    if let Some(number) = number {
        // `::marker` sets `font-variant-numeric: tabular-nums`.
        let mut label = div().child(format!("{number}."));
        label.text_style().font_features =
            Some(FontFeatures(Arc::new(vec![("tnum".to_owned(), 1)])));
        return row.pr(face.size * 0.25).child(label).into_any_element();
    }
    // `(ascent * 2 / 3 + 1) / 2`: the bullet's side in the browser's list marker.
    let side = ((face.size * 0.9 * (2. / 3.) + px(1.)) / 2.).floor();
    let mut bullet = div().size(side).flex_none();
    bullet = match depth {
        0 => bullet.rounded_full().bg(ink),
        1 => bullet.rounded_full().border(px(1.)).border_color(ink),
        _ => bullet.bg(ink),
    };
    row.pr(px(BULLET_GAP))
        .child(div().mt(px(2.)).child(bullet))
        .into_any_element()
}
