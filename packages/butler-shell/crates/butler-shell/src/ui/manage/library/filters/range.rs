//! `library/DateRangeFields.tsx`: calendar dates include the whole final day in the user's
//! timezone.
// CARVE-OUT(G-ds): React's `<input type="date">`; the DS has no date field, so the dates are
// typed as YYYY-MM-DD and apply once they are a valid date (or empty).
use butler_ds::ui::field::{Field, FieldLabel};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::text::Input;
use chrono::{DateTime, Local, NaiveDate, TimeZone as _, Utc};
use gpui::{AnyElement, Entity, IntoElement as _, ParentElement as _, SharedString};

use super::{Filters, iso};
use crate::ui::manage::library::LibraryPage;
use crate::ui::manage::library::main::copy::Words;

const FORMAT: &str = "%Y-%m-%d";

/// `localDate`
fn local_date(time: Option<&String>) -> String {
    time.and_then(|time| DateTime::parse_from_rfc3339(time).ok())
        .map(|time| time.with_timezone(&Local).format(FORMAT).to_string())
        .unwrap_or_default()
}

/// The start (00:00:00.000) or end (23:59:59.999) of the typed day, as the query sends it.
fn day_bound(text: &str, end: bool) -> Option<String> {
    let date = NaiveDate::parse_from_str(text.trim(), FORMAT).ok()?;
    let time = if end {
        date.and_hms_milli_opt(23, 59, 59, 999)?
    } else {
        date.and_hms_milli_opt(0, 0, 0, 0)?
    };
    let local = Local.from_local_datetime(&time).single()?;
    Some(iso(local.with_timezone(&Utc)))
}

fn field(
    page: &Entity<LibraryPage>,
    id: &'static str,
    label: &'static str,
    value: String,
    until: bool,
) -> AnyElement {
    let page = page.clone();
    Field::new(id)
        .child(FieldLabel::new().child(SharedString::from(label)))
        .child(
            Input::new(SharedString::from(format!("{id}-input")))
                .placeholder("YYYY-MM-DD")
                .default_value(value)
                .on_change(move |text, _, cx| {
                    let bound = day_bound(text, until);
                    if bound.is_none() && !text.trim().is_empty() {
                        return;
                    }
                    page.update(cx, |page, cx| {
                        page.set_filters(
                            |filters| {
                                filters.date = None;
                                if until {
                                    filters.until = bound;
                                } else {
                                    filters.since = bound;
                                }
                            },
                            cx,
                        );
                    });
                }),
        )
        .into_any_element()
}

/// `DateRangeFields`
pub(crate) fn range_fields(
    page: &Entity<LibraryPage>,
    filters: &Filters,
    words: &Words,
) -> AnyElement {
    Stack::new()
        .gap(Space::Sm)
        .child(field(
            page,
            "library-since",
            words.since,
            local_date(filters.since.as_ref()),
            false,
        ))
        .child(field(
            page,
            "library-until",
            words.until,
            local_date(filters.until.as_ref()),
            true,
        ))
        .into_any_element()
}
