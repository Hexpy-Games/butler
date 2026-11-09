//! `library/LibraryToolbar.tsx`: search, kind, filters and sort; the chosen filters as removable
//! chips under it.
mod menus;

use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::layout::{Cross, Inline, Justify, Space, Stack};
use butler_ds::ui::segmented_control::{Choice, SegmentedControl};
use butler_ds::ui::tag::Tag;
use butler_ds::ui::text::Input;
use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement as _, ParentElement as _,
    SharedString, Window, div,
};

use super::LibraryPage;
use super::filters::query::kind_param;
use super::filters::{Filters, locale_date};
use super::main::copy::{Words, get};
use super::main::data::KINDS;
use super::open_library;
use crate::ui::manage::LibraryView;
use crate::ui::widgets::anchor;

/// A chosen filter shown as a chip.
enum Chip {
    Tag(String),
    Site,
    Date,
    Range,
}

impl Chip {
    fn clear(&self, filters: &mut Filters) {
        match self {
            Self::Tag(tag) => filters.tags.retain(|other| other != tag),
            Self::Site => filters.site = None,
            Self::Date => filters.date = None,
            Self::Range => {
                filters.since = None;
                filters.until = None;
            }
        }
    }

    fn label(&self, filters: &Filters, words: &Words) -> String {
        let (name, value) = match self {
            Self::Tag(tag) => (words.tags, tag.clone()),
            Self::Site => (words.sites, filters.site.clone().unwrap_or_default()),
            Self::Date => {
                let preset = filters
                    .date
                    .as_ref()
                    .map_or(0, |(preset, _)| preset.index());
                (words.date, words.dates[preset].to_owned())
            }
            Self::Range => {
                let end = |at: Option<&String>| {
                    at.and_then(|at| locale_date(at, words.lang()))
                        .unwrap_or_else(|| "…".to_owned())
                };
                let range = format!(
                    "{} – {}",
                    end(filters.since.as_ref()),
                    end(filters.until.as_ref())
                );
                (words.date, range)
            }
        };
        (words.filter_chip)(name, &value)
    }
}

impl LibraryPage {
    /// `LibraryToolbar`
    pub(crate) fn toolbar(
        &self,
        view: &LibraryView,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = get(cx);
        let page = cx.entity();
        let search = Input::new("library-search")
            .placeholder(words.search)
            .value(self.filters.text.clone())
            .on_change(move |text, _, cx| {
                let text = text.to_owned();
                page.update(cx, |page, cx| page.type_search(text, cx));
            });
        let row = Stack::row()
            .gap(Space::Sm)
            .cross(Cross::Center)
            .justify(Justify::Between)
            .wrap(true)
            .child(self.kind_control(view, words))
            .child(self.filter_menus(view, window, cx));
        let mut column = Stack::new().gap(Space::Md).child(search).child(row);
        column = column.children(self.filter_chips(cx));
        anchor(div().id("library-toolbar"), "library-toolbar")
            .child(column)
            .into_any_element()
    }

    /// The kind control: all, or one kind's full view.
    fn kind_control(&self, view: &LibraryView, words: &'static Words) -> AnyElement {
        let value = view.section.map_or("all", kind_param);
        let ctx = self.ctx.clone();
        let choices = std::iter::once(Choice::new("all", words.all)).chain(
            KINDS
                .iter()
                .map(|kind| Choice::new(kind_param(*kind), words.kind(*kind))),
        );
        SegmentedControl::new("library-kind-control", words.kind_label, value)
            .options(choices)
            .on_value_change(move |value, _, cx| {
                let section = KINDS
                    .iter()
                    .copied()
                    .find(|kind| kind_param(*kind) == value);
                open_library(&ctx, section, None, cx);
            })
            .into_any_element()
    }

    /// The chosen filters as chips with "Clear all".
    fn filter_chips(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let words = get(cx);
        let filters = &self.filters;
        let mut chips: Vec<Chip> = filters.tags.iter().cloned().map(Chip::Tag).collect();
        if filters.site.is_some() {
            chips.push(Chip::Site);
        }
        if filters.date.is_some() {
            chips.push(Chip::Date);
        }
        if filters.since.is_some() || filters.until.is_some() {
            chips.push(Chip::Range);
        }
        if chips.is_empty() {
            return None;
        }
        let page = cx.entity();
        let mut row = Inline::new().gap(Space::Xs);
        for (index, chip) in chips.into_iter().enumerate() {
            let text = chip.label(filters, words);
            let page = page.clone();
            row = row.child(
                Tag::new(
                    SharedString::from(format!("library-filter-chip-{index}")),
                    text,
                )
                .on_remove(words.clear_filters, move |_, _, cx| {
                    page.update(cx, |page, cx| {
                        page.set_filters(|filters| chip.clear(filters), cx);
                    });
                }),
            );
        }
        let clear = page;
        row = row.child(
            Button::new("library-clear-all")
                .size(Size::Xs)
                .variant(Variant::Ghost)
                .text(words.clear_all)
                .on_click(move |_, _, cx| clear.update(cx, super::LibraryPage::clear_filters)),
        );
        Some(
            anchor(div().id("library-filter-chips"), "library-filter-chips")
                .child(row)
                .into_any_element(),
        )
    }
}
