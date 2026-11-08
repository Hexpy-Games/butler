//! The card's glass: Liquid Glass over the wallpaper (`over_content`), as TintedGlass renders it.
//! The lens draws the fill, rim, hairline and shadow, so the hover and focus brightening the
//! DS gave the base and border has nothing to act on here.
use gpui::{AnyElement, Corners, IntoElement as _, Styled as _, canvas};

use crate::tokens::Length;
use crate::ui::context::Ds;
use crate::ui::liquid_glass::{self, LiquidGlass};

/// The glass layer, filling its parent. `_bright` (hover or keyboard focus) and `_tone` (the
/// border's ease) are the old tinted look's inputs; the lens has no counterpart for them.
pub(super) fn layer(ds: &Ds, _bright: bool, _tone: f32) -> AnyElement {
    let (radius, dark) = (ds.len(Length::RadiusPanel), ds.dark());
    let glass = LiquidGlass::over_content().adapt(ds);
    canvas(
        |_, _, _| (),
        move |bounds, (), window, _| {
            let radii = Corners::all(radius);
            liquid_glass::paint(bounds, radii, dark, glass, window);
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
    .into_any_element()
}
