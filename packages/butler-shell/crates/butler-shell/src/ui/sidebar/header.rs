//! SpaceHeader: primary actions and the first two favourites.
use super::{Shell, dialogs::SpaceDialog};
use crate::ui::Icon;
use butler_ds::{
    tokens::Length,
    ui::{
        blocks::{
            nav_row::NavRow,
            nav_section::{NavSectionHeading, sidebar_nav},
        },
        button::Button,
        context::Ds,
        tooltip::Tooltip,
        typo::{Tone, Typo},
    },
};
use gpui::{AnyElement, Context, div, prelude::*};
impl Shell {
    pub(super) fn space_header(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let s = self.theme.strings;
        let mut new = NavRow::new("p-new", s.new_chat)
            .glyph(Icon::PencilLine)
            .on_click(cx.listener(|s, _, w, cx| {
                s.sidebar.new_chat_parent = None;
                s.open_chat(None, w, cx);
            }));
        if self.store.selected().is_none() {
            new = new.active();
        }
        if self.disconnected().is_some() {
            new = new.disabled();
        }
        let mut primary = vec![new.into_any_element()];
        for (id, glyph, label) in [
            ("p-search", Icon::Search, s.search),
            ("p-sched", Icon::Clock3, s.schedules),
            ("p-library", Icon::Library, s.library),
        ] {
            primary.push(
                Tooltip::new(id)
                    .label(s.not_yet)
                    .child(NavRow::new(id, label).glyph(glyph).disabled())
                    .into_any_element(),
            );
        }
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
                Typo::caption(self.copy("Pin conversations here", "자주 쓰는 대화를 고정하세요"))
                    .tone(Tone::Secondary),
            );
        }
        if favorites.len() > 2 {
            shortcuts = shortcuts.child(
                Button::new("all-favorites")
                    .text(self.copy("All favourites", "즐겨찾기 모두 보기"))
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
}
