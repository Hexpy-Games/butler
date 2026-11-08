//! 목록's filters (`LogFilters.tsx`): search, level, source, category, period and the live
//! switch above the log list.
use std::collections::BTreeSet;
use std::time::Duration;

use butler_ds::ui::label::Label;
use butler_ds::ui::layout::{Inline, Space, Stack};
use butler_ds::ui::native_select::NativeSelect;
use butler_ds::ui::switch::Switch;
use butler_ds::ui::text::Input;
use gpui::{AnyElement, Context, Entity, IntoElement as _, ParentElement as _, SharedString};

use super::LogList;
use super::api::{Filter, PERIODS, SEVERITIES};
use super::copy::LogsCopy;

/// One query per pause in typing, not per keystroke.
const SEARCH_DELAY: Duration = Duration::from_millis(300);

/// The sources the agent filters by (process); MCP servers are a category.
const SOURCES: [&str; 2] = ["app", "agent"];

impl LogList {
    /// `onChange`: the query waits for a pause in typing.
    fn search(&mut self, text: String, cx: &mut Context<Self>) {
        if text == self.filter.q {
            self.search = None;
            return;
        }
        self.search = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SEARCH_DELAY).await;
            let _ = this.update(cx, |list, cx| list.set_filter(|filter| filter.q = text, cx));
        }));
    }

    /// `setFilter`: the rows are read again for the new query.
    pub(super) fn set_filter(&mut self, change: impl FnOnce(&mut Filter), cx: &mut Context<Self>) {
        change(&mut self.filter);
        self.reload_rows(cx);
        cx.notify();
    }

    pub(super) fn filters(&self, copy: &'static LogsCopy, cx: &mut Context<Self>) -> AnyElement {
        let view = cx.entity();
        let search = Input::new("logs-search")
            .placeholder(copy.search)
            .default_value(self.filter.q.clone())
            .on_change({
                let view = view.clone();
                move |text, _, cx| {
                    let text = text.to_owned();
                    view.update(cx, |list, cx| list.search(text, cx));
                }
            });
        let selects = Inline::new()
            .child(self.level_filter(copy, &view))
            .child(self.source_filter(copy, &view))
            .child(self.category_filter(copy, &view))
            .child(self.period_filter(copy, &view))
            .child(self.live_switch(copy, &view));
        Stack::new()
            .gap(Space::Sm)
            .child(search)
            .child(selects)
            .into_any_element()
    }

    fn level_filter(&self, copy: &'static LogsCopy, view: &Entity<Self>) -> NativeSelect {
        let view = view.clone();
        let mut select = NativeSelect::new("logs-filter-level")
            .value(self.filter.level.clone())
            .option("", copy.all_levels)
            .on_change(move |value, _, cx| {
                let value = value.to_owned();
                view.update(cx, |list, cx| {
                    list.set_filter(|filter| filter.level = value, cx);
                });
            });
        for (value, label) in SEVERITIES.iter().zip(copy.severity) {
            select = select.option(*value, label);
        }
        select
    }

    fn source_filter(&self, copy: &'static LogsCopy, view: &Entity<Self>) -> NativeSelect {
        let view = view.clone();
        let mut select = NativeSelect::new("logs-filter-source")
            .value(self.filter.source.clone())
            .option("all", copy.all_sources)
            .on_change(move |value, _, cx| {
                let value = value.to_owned();
                view.update(cx, |list, cx| {
                    list.set_filter(|filter| filter.source = value, cx);
                });
            });
        for (value, label) in SOURCES.iter().zip(copy.sources) {
            select = select.option(*value, label);
        }
        select
    }

    /// Every category the list has shown this visit, and the chosen one.
    fn category_filter(&self, copy: &'static LogsCopy, view: &Entity<Self>) -> NativeSelect {
        let view = view.clone();
        let mut names: BTreeSet<&String> = self.rows.seen.iter().collect();
        if !self.filter.category.is_empty() {
            names.insert(&self.filter.category);
        }
        let mut select = NativeSelect::new("logs-filter-category")
            .value(self.filter.category.clone())
            .option("", copy.all_categories)
            .on_change(move |value, _, cx| {
                let value = value.to_owned();
                view.update(cx, |list, cx| {
                    list.set_filter(|filter| filter.category = value, cx);
                });
            });
        for name in names {
            select = select.option(name.clone(), name.clone());
        }
        select
    }

    fn period_filter(&self, copy: &'static LogsCopy, view: &Entity<Self>) -> NativeSelect {
        let view = view.clone();
        let mut select = NativeSelect::new("logs-filter-period")
            .value(self.filter.period)
            .on_change(move |value, _, cx| {
                let Some((period, _)) = PERIODS.iter().find(|(name, _)| *name == value) else {
                    return;
                };
                view.update(cx, |list, cx| {
                    list.set_filter(|filter| filter.period = period, cx);
                });
            });
        for ((value, _), label) in PERIODS.iter().zip(copy.periods) {
            select = select.option(*value, label);
        }
        select
    }

    fn live_switch(&self, copy: &'static LogsCopy, view: &Entity<Self>) -> AnyElement {
        let view = view.clone();
        Inline::new()
            .gap(Space::Xs)
            .child(Label::new().child(SharedString::from(copy.live)))
            .child(
                Switch::new("logs-live")
                    .checked(self.live)
                    .on_checked_change(move |live, _, cx| {
                        view.update(cx, |list, cx| list.set_live(live, cx));
                    }),
            )
            .into_any_element()
    }
}
