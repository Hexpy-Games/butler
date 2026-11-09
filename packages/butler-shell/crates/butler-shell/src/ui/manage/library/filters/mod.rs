//! The 서랍's search and filters (`library/libraryFilters.ts`, `libraryApi.ts` `sinceFor`); they
//! apply on the main screen and in every kind view.
pub(crate) mod query;
pub(crate) mod range;

use std::time::Duration;

use butler_ds::ui::context::Lang;
use chrono::{DateTime, Datelike as _, Local, SecondsFormat, TimeZone as _, Utc};
use gpui::Context;

use super::LibraryPage;
use crate::ui::source::fetch::sleep;

/// Typing updates the field now and the query after this pause (one request per pause).
const SEARCH_PAUSE: Duration = Duration::from_millis(150);

/// `LibrarySort`
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub(crate) enum Sort {
    #[default]
    New,
    Old,
    Name,
    Site,
}

impl Sort {
    pub(crate) const ALL: [Self; 4] = [Self::New, Self::Old, Self::Name, Self::Site];

    /// The `sort` query value; the default is left out.
    pub(crate) fn param(self) -> Option<&'static str> {
        match self {
            Self::New => None,
            Self::Old => Some("old"),
            Self::Name => Some("name"),
            Self::Site => Some("site"),
        }
    }

    pub(crate) fn index(self) -> usize {
        Self::ALL.iter().position(|sort| *sort == self).unwrap_or(0)
    }
}

/// `DatePreset`
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum DatePreset {
    Today,
    Week,
    Month,
    Year,
}

impl DatePreset {
    pub(crate) const ALL: [Self; 4] = [Self::Today, Self::Week, Self::Month, Self::Year];

    pub(crate) fn index(self) -> usize {
        Self::ALL.iter().position(|date| *date == self).unwrap_or(0)
    }

    /// `sinceFor`: the start of the period, as the query sends it.
    pub(crate) fn since(self) -> String {
        let now = Local::now();
        let midnight = |date: chrono::NaiveDate| {
            Local
                .from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap_or_default())
                .single()
                .unwrap_or(now)
        };
        let start = match self {
            Self::Today => midnight(now.date_naive()),
            Self::Week => now - chrono::Duration::days(7),
            Self::Month => now - chrono::Duration::days(30),
            Self::Year => midnight(now.date_naive().with_ordinal(1).unwrap_or(now.date_naive())),
        };
        iso(start.with_timezone(&Utc))
    }
}

/// `toLocaleDateString` of a stored time.
pub(crate) fn locale_date(at: &str, lang: Lang) -> Option<String> {
    let at = DateTime::parse_from_rfc3339(at).ok()?.with_timezone(&Local);
    let format = match lang {
        Lang::Ko => "%Y. %-m. %-d.",
        Lang::En => "%-m/%-d/%Y",
    };
    Some(at.format(format).to_string())
}

pub(crate) fn iso(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `LibraryFilters`: `text` is the field, `q` the query it settled on.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Filters {
    pub(crate) text: String,
    pub(crate) q: String,
    pub(crate) tags: Vec<String>,
    pub(crate) site: Option<String>,
    /// The chosen period and the start it resolved to when it was chosen.
    pub(crate) date: Option<(DatePreset, String)>,
    pub(crate) since: Option<String>,
    pub(crate) until: Option<String>,
    pub(crate) sort: Sort,
}

impl Filters {
    /// `filtersActive`
    pub(crate) fn active(&self) -> bool {
        !self.q.trim().is_empty()
            || !self.tags.is_empty()
            || self.site.is_some()
            || self.date.is_some()
            || self.since.is_some()
            || self.until.is_some()
    }
}

impl LibraryPage {
    /// `setFilters`: the lists are read again for the new query.
    pub(crate) fn set_filters(
        &mut self,
        change: impl FnOnce(&mut Filters),
        cx: &mut Context<Self>,
    ) {
        change(&mut self.filters);
        self.refresh(false, cx);
    }

    /// `clearFilters`
    pub(crate) fn clear_filters(&mut self, cx: &mut Context<Self>) {
        self.search = None;
        self.set_filters(
            |filters| {
                *filters = Filters {
                    sort: filters.sort,
                    ..Filters::default()
                };
            },
            cx,
        );
    }

    /// `typeSearch`
    pub(crate) fn type_search(&mut self, text: String, cx: &mut Context<Self>) {
        self.filters.text.clone_from(&text);
        cx.notify();
        self.search = Some(cx.spawn(async move |this, cx| {
            sleep(cx, SEARCH_PAUSE).await;
            let _ = this.update(cx, |page, cx| {
                page.set_filters(|filters| filters.q = text, cx);
            });
        }));
    }
}
