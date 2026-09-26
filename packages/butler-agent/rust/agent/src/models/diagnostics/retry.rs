use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::header::HeaderMap;

pub(super) fn at(headers: &HeaderMap) -> Option<String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    let retry_after = value(headers, "retry-after");
    if let Some(raw) = retry_after.filter(|value| !value.is_empty()) {
        let timestamp = raw
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .map(|seconds| now.saturating_add((seconds.max(0.0) * 1_000.0) as i64))
            .or_else(|| parse_http_date(raw));
        if let Some(timestamp) = timestamp.filter(|value| *value >= now) {
            return iso(timestamp);
        }
    }
    if let Some(seconds) = value(headers, "ratelimit-reset")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
    {
        return iso(now.saturating_add((seconds * 1_000.0) as i64));
    }
    let seconds = value(headers, "x-ratelimit-reset")?.parse::<f64>().ok()?;
    let timestamp = (seconds * 1_000.0) as i64;
    (seconds.is_finite() && timestamp >= now)
        .then(|| iso(timestamp))
        .flatten()
}

fn value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok().map(str::trim)
}

fn parse_http_date(value: &str) -> Option<i64> {
    let mut parts = value.split_ascii_whitespace();
    let _weekday = parts.next()?;
    let day = parts.next()?.parse::<i64>().ok()?;
    let month = match parts.next()? {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year = parts.next()?.parse::<i64>().ok()?;
    let mut clock = parts.next()?.split(':');
    let hour = clock.next()?.parse::<i64>().ok()?;
    let minute = clock.next()?.parse::<i64>().ok()?;
    let second = clock.next()?.parse::<i64>().ok()?;
    if parts.next()? != "GMT" || parts.next().is_some() {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000)
}

fn iso(timestamp: i64) -> Option<String> {
    let seconds = timestamp.div_euclid(1_000);
    let millis = timestamp.rem_euclid(1_000);
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        day_seconds / 3_600,
        day_seconds % 3_600 / 60,
        day_seconds % 60
    ))
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let shifted = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * shifted + 2) / 5 + day - 1;
    era * 146_097 + (yoe * 365 + yoe / 4 - yoe / 100 + doy) - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let doe = days - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    (year + i64::from(month <= 2), month, day)
}
