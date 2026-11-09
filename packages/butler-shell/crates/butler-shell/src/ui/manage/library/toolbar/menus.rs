//! `library/LibraryFilterMenus.tsx`: tags (all must match), site, date and sort; each trigger
//! shows how many values are chosen.
// CARVE-OUT(G-ds): React keeps the tags menu open while tags are ticked (`preventDefault` in
// `onSelect`); the DS checkbox item closes its menu on select, so the menu closes after each tag.
// The date menu is a popover (preset rows and the range fields): the DS menu holds no fields.
use gpui::Styled as _;
use std::collections::BTreeMap;

use butler_ds::ui::Icon;
use butler_ds::ui::button;
use butler_ds::ui::dropdown_menu::{
    CheckboxItem, DropdownMenu, DropdownMenuContent, Item, RadioGroup, RadioItem,
};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::overlay::place::Align;
use butler_ds::ui::pill_button::PillButton;
use butler_ds::ui::popover::{Popover, PopoverContent};
use butler_ds::ui::select_button::{SelectButton, Size};
use gpui::{
    AnyElement, Context, Entity, IntoElement as _, ParentElement as _, SharedString, Window, div,
};

use crate::ui::manage::library::LibraryPage;
use crate::ui::manage::library::detail::LibraryDialog;
use crate::ui::manage::library::filters::range::range_fields;
use crate::ui::manage::library::filters::{DatePreset, Filters, Sort};
use crate::ui::manage::library::main::copy::get;
use crate::ui::manage::library::main::data::{KINDS, facets_key};
use crate::ui::manage::library::types::{LibraryFacets, SiteCount, TagCount};
use crate::ui::manage::{LibraryKind, LibraryView};
use crate::ui::widgets::anchor;

impl LibraryPage {
    /// The facets of a level, once read.
    fn facets_of(&self, kind: LibraryKind, group: Option<&str>) -> Option<LibraryFacets> {
        let cell = self.facets.get(&facets_key(kind, group))?;
        cell.borrow().data.clone()
    }

    /// The tags the menu lists: the level's own, or every tag on the main screen.
    fn menu_tags(&self, view: &LibraryView) -> Vec<TagCount> {
        match view.section {
            Some(kind) => self
                .facets_of(kind, view.group.as_deref())
                .map(|facets| facets.tags)
                .unwrap_or_default(),
            None => self
                .tags
                .borrow()
                .data
                .as_ref()
                .map(|list| list.tags.clone())
                .unwrap_or_default(),
        }
    }

    /// The sites the menu lists: the level's own, or merged across every kind.
    fn menu_sites(&self, view: &LibraryView) -> Vec<SiteCount> {
        let levels: Vec<(LibraryKind, Option<&str>)> = match view.section {
            Some(kind) => vec![(kind, view.group.as_deref())],
            None => KINDS.iter().map(|kind| (*kind, None)).collect(),
        };
        let mut sites: BTreeMap<String, i64> = BTreeMap::new();
        for (kind, group) in levels {
            for site in self
                .facets_of(kind, group)
                .iter()
                .flat_map(|facets| &facets.sites)
            {
                *sites.entry(site.site.clone()).or_default() += site.count;
            }
        }
        sites
            .into_iter()
            .map(|(site, count)| SiteCount { site, count })
            .collect()
    }

    /// `LibraryFilterMenus`
    pub(crate) fn filter_menus(
        &self,
        view: &LibraryView,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut menus = button::container(button::Size::Sm).child(self.tags_menu(view, window, cx));
        let sites = self.menu_sites(view);
        if !sites.is_empty() {
            menus = menus.child(self.site_menu(&sites, window, cx));
        }
        menus
            .child(self.date_menu(window, cx))
            .child(self.sort_menu(window, cx))
            .into_any_element()
    }

    fn tags_menu(
        &self,
        view: &LibraryView,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = get(cx);
        let page = cx.entity();
        let menu = DropdownMenu::new("library-filter-tags", window, cx);
        let count = self.filters.tags.len();
        let trigger = menu.trigger(|toggle| {
            anchor(div(), "library-filter-tags")
                .child(
                    SelectButton::new("library-filter-tags-button")
                        .size(Size::Sm)
                        .count(count)
                        .text(words.tags)
                        .on_click(toggle.on_click()),
                )
                .into_any_element()
        });
        let tags = self.menu_tags(view);
        let mut content = DropdownMenuContent::new().align(Align::End);
        for tag in &tags {
            let (page, name) = (page.clone(), tag.name.clone());
            let on = self.filters.tags.contains(&tag.name);
            content = content.child(
                CheckboxItem::new(format!("{} · {}", tag.name, tag.count), on).on_checked_change(
                    move |on, _, cx| {
                        page.update(cx, |page, cx| {
                            page.set_filters(|filters| toggle_tag(filters, &name, on), cx);
                        });
                    },
                ),
            );
        }
        if !tags.is_empty() {
            content = content.separator();
        }
        content = content.child(
            Item::new(words.manage_tags)
                .icon(Icon::SlidersHorizontal)
                .on_select(move |_, cx| {
                    page.update(cx, |_, cx| LibraryPage::dialog(LibraryDialog::Tags, cx));
                }),
        );
        let content = menu.content(content, window, cx);
        div()
            .flex()
            .child(trigger)
            .child(content)
            .into_any_element()
    }

    fn site_menu(
        &self,
        sites: &[SiteCount],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = get(cx);
        let page = cx.entity();
        let menu = DropdownMenu::new("library-filter-site", window, cx);
        let count = usize::from(self.filters.site.is_some());
        let trigger = menu.trigger(|toggle| {
            anchor(div(), "library-filter-site")
                .child(
                    SelectButton::new("library-filter-site-button")
                        .size(Size::Sm)
                        .count(count)
                        .text(words.sites)
                        .on_click(toggle.on_click()),
                )
                .into_any_element()
        });
        let mut group = RadioGroup::new(self.filters.site.clone().unwrap_or_default())
            .item(RadioItem::new("", words.all))
            .on_value_change(move |site, _, cx| {
                let site = (!site.is_empty()).then(|| site.to_string());
                page.update(cx, |page, cx| {
                    page.set_filters(|filters| filters.site = site, cx);
                });
            });
        for site in sites {
            group = group.item(RadioItem::new(
                site.site.clone(),
                format!("{} · {}", site.site, site.count),
            ));
        }
        let content = menu.content(
            DropdownMenuContent::new().align(Align::End).child(group),
            window,
            cx,
        );
        div()
            .flex()
            .child(trigger)
            .child(content)
            .into_any_element()
    }

    fn sort_menu(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let words = get(cx);
        let page = cx.entity();
        let menu = DropdownMenu::new("library-filter-sort", window, cx);
        let current = self.filters.sort;
        let trigger = menu.trigger(|toggle| {
            anchor(div(), "library-filter-sort")
                .child(
                    SelectButton::new("library-filter-sort-button")
                        .size(Size::Sm)
                        .text(words.sorts[current.index()])
                        .on_click(toggle.on_click()),
                )
                .into_any_element()
        });
        let mut group =
            RadioGroup::new(current.index().to_string()).on_value_change(move |value, _, cx| {
                let sort = value
                    .parse::<usize>()
                    .ok()
                    .and_then(|index| Sort::ALL.get(index).copied());
                if let Some(sort) = sort {
                    page.update(cx, |page, cx| {
                        page.set_filters(|filters| filters.sort = sort, cx);
                    });
                }
            });
        for (index, label) in words.sorts.iter().enumerate() {
            group = group.item(RadioItem::new(index.to_string(), *label));
        }
        let content = menu.content(
            DropdownMenuContent::new().align(Align::End).child(group),
            window,
            cx,
        );
        div()
            .flex()
            .child(trigger)
            .child(content)
            .into_any_element()
    }

    fn date_menu(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let words = get(cx);
        let page = cx.entity();
        let popover = Popover::new("library-filter-date", window, cx);
        let chosen = self.filters.date.as_ref().map(|(preset, _)| *preset);
        let active = usize::from(
            chosen.is_some() || self.filters.since.is_some() || self.filters.until.is_some(),
        );
        let trigger = popover.trigger(|toggle| {
            anchor(div(), "library-filter-date")
                .child(
                    SelectButton::new("library-filter-date-button")
                        .size(Size::Sm)
                        .count(active)
                        .text(words.date)
                        .on_click(toggle.on_click()),
                )
                .into_any_element()
        });
        let mut presets =
            Stack::new()
                .gap(Space::Xs)
                .child(date_row(&page, None, chosen, words.any_date));
        for (preset, label) in DatePreset::ALL.into_iter().zip(words.dates) {
            presets = presets.child(date_row(&page, Some(preset), chosen, label));
        }
        let content = popover.content(
            PopoverContent::new()
                .align(Align::End)
                .side_offset(4.)
                .child(presets)
                .child(range_fields(&page, &self.filters, words)),
            window,
            cx,
        );
        div()
            .flex()
            .child(trigger)
            .child(content)
            .into_any_element()
    }
}

/// `toggle` of the tags menu: a tag joins the filter or leaves it.
fn toggle_tag(filters: &mut Filters, name: &str, on: bool) {
    filters.tags.retain(|tag| tag != name);
    if on {
        filters.tags.push(name.to_owned());
    }
}

/// One period of the date menu: a preset, or none ("any time"); it clears the typed range.
fn date_row(
    page: &Entity<LibraryPage>,
    preset: Option<DatePreset>,
    chosen: Option<DatePreset>,
    label: &'static str,
) -> AnyElement {
    let page = page.clone();
    let id = SharedString::from(format!(
        "library-date-{}",
        preset.map_or(4, DatePreset::index)
    ));
    PillButton::new(id)
        .text(label)
        .stretch()
        .pressed(preset == chosen)
        .on_click(move |_, _, cx| {
            page.update(cx, |page, cx| {
                page.set_filters(
                    |filters| {
                        filters.date = preset.map(|preset| (preset, preset.since()));
                        filters.since = None;
                        filters.until = None;
                    },
                    cx,
                );
            });
        })
        .into_any_element()
}
