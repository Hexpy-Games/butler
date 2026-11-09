//! `library/LibraryKindView.tsx`: one kind's full list (or one group of it), with the group
//! chips, the selection bar, the cards and the next page.
mod chips;
mod select;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Cross, Grid, Justify, Space, Stack};
use butler_ds::ui::typo::Typo;
use gpui::{
    AnyElement, Context, Entity, InteractiveElement as _, IntoElement as _, ParentElement as _, div,
};

pub(crate) use self::select::Selection;
use super::LibraryPage;
use super::detail::LibraryDialog;
use super::main::card::CardSelection;
use super::main::copy::{Words, get};
use super::main::data::has_groups;
use super::main::{CARD_COLUMNS, import_button};
use super::types::LibraryItem;
use crate::ui::manage::{LibraryKind, LibraryView};
use crate::ui::widgets::anchor;

/// A small button of the selection bar that acts on the page.
fn bar_button(
    page: &Entity<LibraryPage>,
    id: &'static str,
    text: &'static str,
    variant: Variant,
    act: impl Fn(&mut LibraryPage, &mut Context<LibraryPage>) + 'static,
) -> Button {
    let page = page.clone();
    Button::new(id)
        .size(Size::Sm)
        .variant(variant)
        .text(text)
        .on_click(move |_, _, cx| page.update(cx, |page, cx| act(page, cx)))
}

impl LibraryPage {
    /// `LibraryKindView`
    pub(crate) fn kind_view(
        &self,
        view: &LibraryView,
        kind: LibraryKind,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = get(cx);
        let picked = self.selected_items();
        let mode = !picked.is_empty();
        let mut column = Stack::new().gap(Space::Lg);
        if has_groups(kind) {
            column = column.child(self.group_chips(kind, view, cx));
        }
        if mode {
            column = column.child(self.selection_bar(kind, picked.clone(), cx));
        }
        let cards: Vec<AnyElement> = self
            .list
            .items
            .iter()
            .map(|item| {
                let selected = self.selection.ids.contains(&item.id);
                self.item_card(
                    item,
                    view,
                    &picked,
                    Some(CardSelection { mode, selected }),
                    cx,
                )
            })
            .collect();
        column = column.child(
            Grid::new("library-kind-cards")
                .columns(CARD_COLUMNS)
                .gap(Space::Md)
                .page_container()
                .children(cards),
        );
        column = self.kind_footer(column, kind, words, cx);
        anchor(div().id("library-kind"), "library-kind")
            .child(column)
            .into_any_element()
    }

    /// The empty line, the import hint of an empty bookmark list, and the next page.
    fn kind_footer(
        &self,
        mut column: Stack,
        kind: LibraryKind,
        words: &'static Words,
        cx: &mut Context<Self>,
    ) -> Stack {
        let empty = !self.list.loading && self.list.items.is_empty();
        if empty {
            let message = if self.list.failed {
                words.failed
            } else {
                words.no_items
            };
            column = column.child(EmptyLine::new(message));
            if !self.list.failed && kind == LibraryKind::Bookmark {
                column = column.child(import_button(&self.ctx, words));
            }
        }
        if self.list.next.is_some() {
            let page = cx.entity();
            let mut more = Button::new("library-load-more")
                .variant(Variant::Ghost)
                .text(words.load_more)
                .on_click(move |_, _, cx| page.update(cx, super::LibraryPage::load_more));
            if self.list.loading {
                more = more.disabled();
            }
            column = column.child(more);
        }
        column
    }

    /// The selection bar: the check, the count and the actions on the picked cards.
    fn selection_bar(
        &self,
        kind: LibraryKind,
        items: Vec<LibraryItem>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = get(cx);
        let page = cx.entity();
        let all = items.len() == self.list.items.len();
        let toggle = page.clone();
        let check = IconButton::new("library-select-all", words.select)
            .glyph(if all { Icon::CheckIcon } else { Icon::Minus })
            .on_click(move |_, _, cx| toggle.update(cx, super::LibraryPage::toggle_all));
        let left = Stack::row()
            .gap(Space::Sm)
            .cross(Cross::Center)
            .child(check)
            .child(Typo::text((words.selected)(items.len())));
        let mut actions = button::container(Size::Sm);
        if has_groups(kind) {
            let moving = items.clone();
            actions = actions.child(bar_button(
                &page,
                "library-move",
                words.groups(kind).move_to,
                Variant::Outline,
                move |_, cx| {
                    let items = moving.clone();
                    LibraryPage::dialog(LibraryDialog::Move { kind, items }, cx);
                },
            ));
        }
        let tagging = items.clone();
        actions = actions
            .child(bar_button(
                &page,
                "library-tag",
                words.edit_tags,
                Variant::Outline,
                move |_, cx| {
                    LibraryPage::dialog(LibraryDialog::TagItems(tagging.clone()), cx);
                },
            ))
            .child(bar_button(
                &page,
                "library-delete",
                words.delete_item,
                Variant::Ghost,
                move |_, cx| {
                    LibraryPage::dialog(LibraryDialog::DeleteItems(items.clone()), cx);
                },
            ))
            .child(bar_button(
                &page,
                "library-cancel",
                words.cancel,
                Variant::Ghost,
                |page, cx| {
                    page.clear_selection(cx);
                },
            ));
        anchor(div().id("library-selection"), "library-selection")
            .child(
                Stack::row()
                    .gap(Space::Sm)
                    .cross(Cross::Center)
                    .justify(Justify::Between)
                    .wrap(true)
                    .child(left)
                    .child(actions),
            )
            .into_any_element()
    }
}
