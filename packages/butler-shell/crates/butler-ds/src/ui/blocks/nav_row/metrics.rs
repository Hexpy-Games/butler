//! What a NavRow reads from the sidebar density tokens and the surface it sits on.
use gpui::{App, Hsla};

use crate::tokens::{Color, Density, Length, TokenContext};
use crate::ui::blocks::scope;
use crate::ui::context::Ds;
use crate::ui::convert;

/// The row's box, from the density's tokens (`[data-sidebar-density]`, tokens.css:1008-1049).
#[derive(Clone, Copy)]
pub(crate) struct Metrics {
    pub(crate) height: f32,
    pub(crate) padding: f32,
    pub(crate) gap: f32,
    pub(crate) icon: f32,
    pub(crate) action: f32,
}

/// Without a density attribute the row reads the `:root` values: 30px rows, a 10px gap and the
/// 16px icon (tokens.css:785-788), and in a compact window the `@media (width <= 640px)` ones.
pub(crate) fn metrics(ds: &Ds, density: Option<Density>) -> Metrics {
    if let Some(density) = density {
        let tokens = TokenContext {
            density,
            ..*ds.tokens()
        };
        return Metrics {
            height: tokens.len(Length::SidebarRowHeight),
            padding: tokens.len(Length::SidebarRowPaddingInline),
            gap: tokens.len(Length::SidebarRowGap),
            icon: tokens.len(Length::SidebarIconSize),
            action: tokens.len(Length::SidebarActionSize),
        };
    }
    let padding = f32::from(ds.len(Length::SpaceSm));
    if ds.compact() {
        Metrics {
            height: 48., // DS: tokens.css:1116
            padding,
            gap: f32::from(ds.len(Length::SpaceMd)),
            icon: 22.,   // DS: tokens.css:1118
            action: 44., // DS: tokens.css:1117
        }
    } else {
        Metrics {
            height: 30., // DS: tokens.css:785
            padding,
            gap: 10., // DS: tokens.css:788
            icon: f32::from(ds.len(Length::IconSizeMd)),
            action: 24., // DS: tokens.css:786
        }
    }
}

/// The density in effect for a row or a children guide: its own, else the enclosing sidebar's.
pub(crate) fn density_of(ds: &Ds, own: Option<Density>, cx: &App) -> Option<Density> {
    own.or_else(|| scope::in_density(cx).then(|| ds.density()))
}

/// The (hover, selected) fills of a nav row: the surface's row family (`--nav-hover-bg`,
/// `--nav-selected-bg`) where it sets one, otherwise the `--selection` shades. Inside a
/// SidebarShell `--selection-strong` is 75% of `--selection` (SidebarShell.module.css:19).
pub(crate) fn fills(ds: &Ds, cx: &App) -> (Hsla, Hsla) {
    let selection = ds.color(Color::Selection);
    let strong = if scope::in_density(cx) {
        convert::with_alpha(selection, 0.75) // DS: SidebarShell.module.css:19
    } else {
        ds.color(Color::SelectionStrong)
    };
    let Some((hover, selected)) = scope::nav_fills(cx) else {
        return (selection, strong);
    };
    let pick = |token: Color, shade: Hsla| match ds.resolve(token) {
        Color::Selection | Color::SelectionStrong => shade,
        _ => ds.try_color(token).unwrap_or(shade),
    };
    (pick(hover, selection), pick(selected, strong))
}
