//! Liquid Glass through the Butler gpui-ce lens (tag butler-lens-1): the glass elements
//! (dialog, round buttons, controls on glass) use the native-matched material ([`native`]) at
//! the owner's hairline strength. The composer card is the DS `ComposerCard`.
//!
//! Children painted after a glass layer stay sharp above it.
mod native;
pub(crate) mod press;

use gpui::{Hsla, canvas, prelude::*};

pub(crate) use native::{Place, paint_fill};

use crate::ui::theme::{Theme, rgba};

/// How a native glass element sits and responds.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Native {
    pub(crate) place: Place,
    /// Added to the fill's brightness (hover, press).
    pub(crate) lift: f32,
    /// Growth per side while pressed (pt), about the centre.
    pub(crate) grow: f32,
}

impl Native {
    pub(crate) fn over_content() -> Self {
        Self {
            place: Place::Content,
            lift: 0.,
            grow: 0.,
        }
    }

    pub(crate) fn on_glass(lift: f32, grow: f32) -> Self {
        Self {
            place: Place::OnGlass,
            lift,
            grow,
        }
    }
}

/// A native glass layer filling its (relative) parent.
pub(crate) fn layer(theme: &Theme, radius: f32, glass: Native) -> impl IntoElement {
    let dark = theme.dark;
    canvas(
        |_, _, _| (),
        move |bounds, (), window, _| {
            let (w, h) = (bounds.size.width.as_f32(), bounds.size.height.as_f32());
            if w < 1. || h < 1. {
                return;
            }
            let r = radius.min(w / 2.).min(h / 2.);
            let circle = (w - h).abs() < 0.5 && r >= w / 2. - 0.5;
            let m = native::material(dark, w, h, circle, glass.place);
            native::paint(bounds, r, &m, glass.lift, glass.grow, window);
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// The veil under a dialog at full open (native alert dimming: 0.4 bg + 102 light, 0.39 bg
/// + 14 dark, as the owner tuned it: alpha 0.60).
pub(crate) fn veil(dark: bool) -> Hsla {
    let grey = if dark { 23 } else { 170 };
    rgba(grey, grey, grey, 0.60)
}
