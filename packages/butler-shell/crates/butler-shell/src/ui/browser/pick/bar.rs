use super::words;
use crate::ui::{browser::model::Tab, i18n::Locale, widgets::anchor};
use butler_ds::{
    tokens::Length,
    ui::{
        Icon,
        blocks::selection_bar::{SelectionBar, SelectionBarAction},
        context::{Ds, Lang},
        toast::{self, Toast},
    },
};
use gpui::{AnyElement, App, SharedString, div, prelude::*};

pub(super) fn bar(tab: &Tab, cx: &App) -> AnyElement {
    let w = words(cx);
    let count = tab.selections.len();
    let attach_id = tab.id.clone();
    let clear_id = tab.id.clone();
    let bar = SelectionBar::new(
        SharedString::from(format!("browser-selection-{}", tab.id.0)),
        count,
        (w.selected)(count),
        w.clear,
    )
    .hint(w.hint)
    .empty_reason(w.first)
    .action(
        SelectionBarAction::new("attach", w.attach, Icon::MessageSquarePlus)
            .on_select(move |_, cx| super::attach(&attach_id, cx)),
    )
    .action(later("save-image", w.save, Icon::ImageIcon))
    .action(later("copy-text", w.copy, Icon::Copy))
    .action(later("scrap", w.scrap, Icon::Scrap))
    .on_clear(move |_, cx| super::clear(&clear_id, cx));
    let bar = if tab.picking { bar } else { bar.compact() };
    let ds = Ds::get(cx);
    let room = ds.len(Length::SpaceLg);
    let height = ds.len(if tab.picking {
        Length::BrowserBandHeight
    } else {
        Length::ControlHeightLg
    });
    // The page surface under the overlay takes every press it is not occluded from.
    // Electron's overlay withholds the bar's box from the page (`chrome`); the DS host's
    // strip is the box the shell can name.
    let shield = anchor(
        div()
            .absolute()
            .left(room)
            .right(room)
            .bottom(room)
            .h(height)
            .occlude(),
        "browser-selection-bar",
    );
    div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .child(shield)
        .child(bar)
        .into_any_element()
}

// CARVE-OUT(pick-slice-3): Save image, Copy text and Scrap land with the drawer; until then they say so.
fn later(key: &'static str, label: &'static str, glyph: Icon) -> SelectionBarAction {
    SelectionBarAction::new(key, label, glyph).on_select(|_, cx| {
        toast::show(
            cx,
            Toast::message(match Ds::get(cx).lang() {
                Lang::Ko => Locale::Ko.strings().not_yet,
                Lang::En => Locale::En.strings().not_yet,
            }),
        );
    })
}
