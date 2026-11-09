//! `library/LibraryMain.tsx` `MainSection`: one kind on the main screen.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Grid, Space, Stack};
use butler_ds::ui::section::Section;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement as _, ParentElement as _,
    SharedString, div,
};

use super::card::CardSelection;
use super::copy::get;
use super::data::{facets_key, has_groups};
use super::{CARD_COLUMNS, import_button};
use crate::ui::manage::library::LibraryPage;
use crate::ui::manage::library::filters::query::{Query, kind_param};
use crate::ui::manage::library::open_library;
use crate::ui::manage::library::types::LibraryItem;
use crate::ui::manage::{LibraryKind, LibraryView};
use crate::ui::widgets::anchor;

impl LibraryPage {
    /// `MainSection`
    pub(crate) fn main_section(
        &self,
        kind: LibraryKind,
        columns: usize,
        view: &LibraryView,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = get(cx);
        let filtered = self.filters.active();
        let grouped = has_groups(kind) && !filtered;
        let query = Query::new(kind, grouped.then(|| "none".to_owned()), &self.filters);
        let cell = self.rows.get(&query).cloned();
        let read = cell.as_ref().map(|cell| cell.borrow());
        let data = read.as_ref().and_then(|read| read.data.as_ref());
        let items: &[LibraryItem] = data.map_or(&[][..], |page| page.items.as_slice());
        let more = data.is_some_and(|page| page.next_cursor.is_some());
        let settled = read.as_ref().is_some_and(|read| read.settled());
        let failed = read.as_ref().is_some_and(|read| read.failed);
        let total = self
            .facets
            .get(&facets_key(kind, None))
            .and_then(|cell| cell.borrow().data.as_ref().map(|facets| facets.total))
            .unwrap_or(0);
        let groups = self
            .groups
            .get(&kind)
            .filter(|_| grouped)
            .and_then(|cell| cell.borrow().data.clone());
        let tiles = groups.as_ref().filter(|groups| !groups.groups.is_empty());
        let row = &items[..items.len().min(columns)];
        let count = match (filtered, more) {
            (true, true) => format!("{}+", items.len()),
            (true, false) => items.len().to_string(),
            _ => total.to_string(),
        };
        let loose = groups.as_ref().map_or(0, |groups| groups.ungrouped);
        let mut section = self.section_head(kind, count, cx);
        if let Some(groups) = tiles {
            let limit = if columns == 2 { 4 } else { columns };
            section = section.child(
                Grid::new("library-group-tiles")
                    .columns(CARD_COLUMNS)
                    .gap(Space::Md)
                    .page_container()
                    .children(self.group_tiles(kind, &groups.groups, limit, cx)),
            );
            if !row.is_empty() {
                section = section.child(
                    Stack::row()
                        .gap(Space::Sm)
                        .cross(Cross::Baseline)
                        .child(Typo::text(words.groups(kind).ungrouped).tone(Tone::Secondary))
                        .child(Typo::caption(loose.to_string()).tone(Tone::Tertiary)),
                );
            }
        }
        if !row.is_empty() {
            section = section.child(self.card_row(row, view, cx));
        }
        if settled && row.is_empty() && tiles.is_none() {
            let message = if failed { words.failed } else { words.no_items };
            section = section.child(EmptyLine::new(message));
            if !failed && kind == LibraryKind::Bookmark {
                section = section.child(import_button(&self.ctx, words));
            }
        }
        anchor(div(), "library-section")
            .child(section)
            .into_any_element()
    }

    /// The section's title with the kind's count, and "View all".
    fn section_head(&self, kind: LibraryKind, count: String, cx: &mut Context<Self>) -> Section {
        let words = get(cx);
        Section::new(SharedString::from(format!(
            "library-section-{}",
            kind_param(kind)
        )))
        .title_element(
            Stack::row()
                .gap(Space::Sm)
                .cross(Cross::Baseline)
                .child(Typo::panel_section_title(words.kind(kind)))
                .child(Typo::caption(count).tone(Tone::Tertiary)),
        )
        .actions(self.view_all(kind, cx))
    }

    /// The latest items of a kind: one row of cards.
    fn card_row(
        &self,
        row: &[LibraryItem],
        view: &LibraryView,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let cards: Vec<AnyElement> = row
            .iter()
            .map(|item| self.item_card(item, view, &[], None::<CardSelection>, cx))
            .collect();
        Grid::new("library-row")
            .columns(CARD_COLUMNS)
            .gap(Space::Md)
            .page_container()
            .children(cards)
            .into_any_element()
    }

    /// "View all": the kind's own screen.
    fn view_all(&self, kind: LibraryKind, cx: &mut Context<Self>) -> AnyElement {
        let ctx = self.ctx.clone();
        let chevron = icon(Icon::ChevronRight, IconSize::Sm, Ds::get(cx));
        let name = format!("library-view-all-{}", kind_param(kind));
        let button = Button::new(SharedString::from(name.clone()))
            .size(Size::Xs)
            .variant(Variant::Ghost)
            .icon_end(chevron)
            .text(get(cx).view_all)
            .on_click(move |_, _, cx| open_library(&ctx, Some(kind), None, cx));
        anchor(div().id(SharedString::from(name.clone())), &name)
            .child(button)
            .into_any_element()
    }
}
