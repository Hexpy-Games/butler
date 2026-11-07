//! The source of a picture or an answer item: its site and when it was read
//! (`siteOf`, `checkedLabel` of `imageActions.ts`).
use chrono::{DateTime, Local};

/// `new URL(url).hostname` without a leading `www.`.
pub(crate) fn site_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    Some(host.strip_prefix("www.").unwrap_or(host).to_owned())
}

/// `checkedLabel`: the read time as the source line shows it, today's time or a short date, in
/// local time.
pub(crate) fn checked_label(checked: &str) -> Option<String> {
    let date = DateTime::parse_from_rfc3339(checked)
        .ok()?
        .with_timezone(&Local);
    let format = if date.date_naive() == Local::now().date_naive() {
        "%H:%M"
    } else {
        "%Y-%m-%d"
    };
    Some(date.format(format).to_string())
}
