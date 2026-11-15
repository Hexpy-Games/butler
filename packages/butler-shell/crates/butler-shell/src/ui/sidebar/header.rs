//! SpaceHeader: primary actions and the first two favourites.
use super::{Shell, dialogs::SpaceDialog};
use crate::ui::Icon;
use crate::ui::manage::View;
use crate::ui::shell::TogglePalette;
use crate::ui::widgets::anchor;
use butler_ds::{
    tokens::Length,
    ui::{
        blocks::{
            nav_row::NavRow,
            nav_section::{NavSectionHeading, sidebar_nav},
        },
        button::{Button, Size, Variant},
        context::Ds,
        typo::{Tone, Typo},
    },
};
use gpui::{AnyElement, Context, div, prelude::*};
impl Shell {
    pub(super) fn space_header(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let s = self.theme.strings;
        let primary = self.primary_entries(cx);
        let favorites: Vec<_> = self
            .store
            .navigation
            .rows()
            .into_iter()
            .filter(|r| r.pinned)
            .collect();
        let mut shortcuts = div()
            .flex()
            .flex_col()
            .gap(Ds::get(cx).len(Length::SpaceXs));
        for row in favorites.iter().take(2) {
            shortcuts = shortcuts.child(self.space_row(row, false, true, "favorites", cx));
        }
        if favorites.is_empty() {
            shortcuts = shortcuts.child(
                div().px(Ds::get(cx).len(Length::SpaceSm)).child(
                    Typo::caption(self.copy(
                        "Pin conversations you visit often.",
                        "자주 찾는 대화를 고정해 보세요.",
                    ))
                    .tone(Tone::Secondary),
                ),
            );
        }
        if favorites.len() > 2 {
            shortcuts = shortcuts.child(
                Button::new("all-favorites")
                    .variant(Variant::Inline)
                    .size(Size::Sm)
                    .text(self.copy("Show all favorites", "즐겨찾기 모두 보기"))
                    .on_click(cx.listener(|s, _, _, cx| {
                        s.sidebar.set_dialog(Some(SpaceDialog::Favorites));
                        cx.notify();
                    })),
            );
        }
        div()
            .flex()
            .flex_col()
            .gap(Ds::get(cx).len(Length::Space2xl))
            .child(sidebar_nav(primary, Ds::get(cx)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(Ds::get(cx).len(Length::SpaceSm))
                    .child(NavSectionHeading::new(s.favorites))
                    .child(shortcuts),
            )
            .into_any_element()
    }

    /// The primary actions: new chat, search, 예약 작업, 브라우저 and 서랍, each active on its view.
    fn primary_entries(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let s = self.theme.strings;
        let mut new = NavRow::new("p-new", s.new_chat)
            .glyph(Icon::PencilLine)
            .on_click(cx.listener(|s, _, w, cx| {
                s.sidebar.new_chat_parent = None;
                s.open_chat(None, w, cx);
            }));
        let view = self.view(cx);
        if view == View::Session && self.store.selected().is_none() {
            new = new.active();
        }
        if self.disconnected().is_some() {
            new = new.disabled();
        }
        let search = NavRow::new("p-search", s.search)
            .glyph(Icon::Search)
            .on_click(cx.listener(|s, _, w, cx| s.toggle_palette(&TogglePalette, w, cx)));
        let mut schedules = NavRow::new("p-sched", s.schedules)
            .glyph(Icon::Clock3)
            .on_click(cx.listener(|s, _, w, cx| s.set_view(View::Automations, w, cx)));
        if matches!(view, View::Automations | View::AutomationDetail(_)) {
            schedules = schedules.active();
        }
        let mut browser = NavRow::new(
            "p-browser",
            crate::ui::i18n::browser::BrowserStrings::get(cx).title,
        )
        .glyph(Icon::Globe2)
        .on_click(cx.listener(|s, _, w, cx| s.set_view(View::Browser, w, cx)));
        if view == View::Browser {
            browser = browser.active();
        }
        if !cx
            .global::<crate::ui::browser::model::BrowserState>()
            .enabled()
        {
            browser = browser.disabled();
        }
        // CARVE-OUT(G-cef): `LibraryEntry`'s `onDwell={beginDwell}` serves the in-app browser's
        // element drags; it lands with the browser (`library::detail::drop_dwell`).
        let mut library = NavRow::new("p-library", s.library)
            .glyph(Icon::Library)
            .on_click(cx.listener(|s, _, w, cx| s.open_library(w, cx)));
        if matches!(view, View::Library(_)) {
            library = library.active();
        }
        vec![
            new.into_any_element(),
            search.into_any_element(),
            anchor(div(), "sidebar-schedules")
                .child(schedules)
                .into_any_element(),
            browser.into_any_element(),
            anchor(div(), "library-entry")
                .child(library)
                .into_any_element(),
        ]
    }
}
