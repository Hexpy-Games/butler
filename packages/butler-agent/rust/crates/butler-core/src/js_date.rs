//! ECMAScript date formatting and explicit timestamp parsing boundaries.
//!
//! `parse_iso_millis` accepts canonical/offset writer timestamps. The separate
//! `parse_date_millis` implements the Bun-compatible Date.parse grammar with
//! host-local conversion injected. Neither rewrites persisted input.

mod parse;
pub use parse::parse_date_millis;

use chrono::{DateTime, Timelike};

const MILLIS_PER_DAY: i64 = 86_400_000;
const TIME_CLIP: i64 = 8_640_000_000_000_000;

/// `Date.prototype.toISOString` for a system time (millisecond precision).
pub fn iso_from_system_time(time: std::time::SystemTime) -> String {
    let millis = match time.duration_since(std::time::UNIX_EPOCH) {
        Ok(after) => i64::try_from(after.as_millis()).unwrap_or(i64::MAX),
        Err(before) => {
            i64::try_from(before.duration().as_millis()).map_or(i64::MIN, |millis| -millis)
        }
    };
    // Any representable system time is within the ECMAScript time clip in
    // practice; clamp so the formatter always has a value.
    format_iso_millis(millis.clamp(-TIME_CLIP, TIME_CLIP)).unwrap_or_default()
}

/// `Date.prototype.toISOString` of epoch milliseconds; `None` outside the
/// ECMAScript time clip. Years outside 0..=9999 use the signed six-digit form.
pub fn format_iso_millis(value: i64) -> Option<String> {
    if !(-TIME_CLIP..=TIME_CLIP).contains(&value) {
        return None;
    }
    let days = value.div_euclid(MILLIS_PER_DAY);
    let time = value.rem_euclid(MILLIS_PER_DAY);
    let (year, month, day) = civil_from_days(days);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    Some(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        time / 3_600_000,
        time / 60_000 % 60,
        time / 1000 % 60,
        time % 1000
    ))
}

/// ISO projection of a JavaScript Date value represented by epoch milliseconds.
/// Nonfinite/out-of-range values represent Invalid Date, without inventing a date.
pub fn format_date_value(value: f64) -> Option<String> {
    if !value.is_finite() || value.abs() > TIME_CLIP as f64 {
        return None;
    }
    #[expect(
        clippy::cast_possible_truncation,
        reason = "finite and within TIME_CLIP, so the truncated value fits i64"
    )]
    let millis = value.trunc() as i64;
    format_iso_millis(millis)
}

/// `Date.parse` of an ISO timestamp to epoch milliseconds; `None` for
/// invalid dates, leap seconds and values outside the time clip.
pub fn parse_iso_millis(value: &str) -> Option<i64> {
    if let Some(parsed) = parse_canonical(value) {
        return Some(parsed);
    }
    // Chrono also represents leap seconds; JavaScript Date.parse rejects them.
    let parsed = DateTime::parse_from_rfc3339(value).ok()?;
    if parsed.nanosecond() >= 1_000_000_000 {
        return None;
    }
    let millis = parsed.timestamp_millis();
    (-TIME_CLIP..=TIME_CLIP).contains(&millis).then_some(millis)
}

fn parse_canonical(value: &str) -> Option<i64> {
    let year_len = match value.as_bytes().first()? {
        b'+' | b'-' => 7,
        _ => 4,
    };
    let b = value.as_bytes();
    // `YYYY-MM-DDTHH:mm:ss.sssZ` separators, offset from the end of the year.
    let separators = [
        (0, b'-'),
        (3, b'-'),
        (6, b'T'),
        (9, b':'),
        (12, b':'),
        (15, b'.'),
        (19, b'Z'),
    ];
    if b.len() != year_len + 20
        || separators
            .iter()
            .any(|(offset, expected)| b.get(year_len + offset) != Some(expected))
    {
        return None;
    }
    let field = |start: usize, end: usize| b.get(start..end).and_then(digits);
    let unsigned_year = field(usize::from(year_len == 7), year_len)?;
    let year = if b.first() == Some(&b'-') {
        if unsigned_year == 0 {
            return None;
        }
        -unsigned_year
    } else {
        unsigned_year
    };
    let month = field(year_len + 1, year_len + 3)?;
    let day = field(year_len + 4, year_len + 6)?;
    let hour = field(year_len + 7, year_len + 9)?;
    let minute = field(year_len + 10, year_len + 12)?;
    let second = field(year_len + 13, year_len + 15)?;
    let millis = field(year_len + 16, year_len + 19)?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 24
        || minute > 59
        || second > 59
        || (hour == 24 && minute + second + millis != 0)
    {
        return None;
    }
    let value = days_from_civil(year, month, day) * MILLIS_PER_DAY
        + hour * 3_600_000
        + minute * 60_000
        + second * 1000
        + millis;
    (-TIME_CLIP..=TIME_CLIP).contains(&value).then_some(value)
}

fn digits(value: &[u8]) -> Option<i64> {
    value.iter().try_fold(0, |acc, byte| {
        byte.is_ascii_digit()
            .then(|| acc * 10 + i64::from(byte - b'0'))
    })
}

// Gregorian dates are partitioned into 400-year eras, with March as month 0.
// These inverse integer transforms cover the entire Date TimeClip interval.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month + 2) / 5 + day - 1;
    era * 146_097 + year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year - 719_468
}

/// The proleptic Gregorian `(year, month, day)` of days since the Unix epoch.
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month + 2) / 5 + 1;
    let month = month + if month < 10 { 3 } else { -9 };
    (year + i64::from(month <= 2), month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pure-logic table: the JavaScript `Date` grammar (UTC and local forms,
    /// invalid dates, the extended-year range), which input consults the
    /// local conversion, and the persisted ISO round trip with its time clip.
    // test-category: pure-logic
    #[test]
    fn date_grammar_and_persisted_iso_round_trip() {
        // (text, parsed in UTC, parsed in a fixed UTC+09:00 zone)
        for (text, utc, plus_nine) in [
            ("2000-04-31", Some(957_139_200_000), Some(957_139_200_000)),
            (
                "2024-02-30 1:2",
                Some(1_709_254_920_000),
                Some(1_709_222_520_000),
            ),
            (
                "2024-02-30 1:2+09",
                Some(1_709_222_520_000),
                Some(1_709_222_520_000),
            ),
            (
                "Mar 30 1999 12:34 GMT-0800",
                Some(922_826_040_000),
                Some(922_826_040_000),
            ),
            (
                "1900-02-29T12:34:56Z",
                Some(-2_203_845_904_000),
                Some(-2_203_845_904_000),
            ),
            (
                "+010000-01-01T01:02:03.123456789999",
                Some(253_402_304_523_123),
                Some(253_402_272_123_123),
            ),
            ("Jan 1 50", Some(-631_152_000_000), Some(-631_184_400_000)),
            (
                "Dec 29 49",
                Some(2_524_348_800_000),
                Some(2_524_316_400_000),
            ),
            ("2024-13-01T24:00:00-00:30", None, None),
            ("January 32 1999 12::34 GMT+9", None, None),
            ("19700131", None, None),
            (
                "+275760-09-13T00:00:00Z",
                Some(8_640_000_000_000_000),
                Some(8_640_000_000_000_000),
            ),
        ] {
            for (offset, expected) in [(0, utc), (9 * 3_600_000, plus_nine)] {
                assert_eq!(
                    parse_date_millis(text, &|local| local.checked_sub(offset)),
                    expected,
                    "{text} at offset {offset}"
                );
            }
        }

        // UTC dates never consult the local conversion; invalid host output is rejected.
        assert_eq!(
            parse_date_millis("1970-01-01", &|_| panic!("date only is UTC")),
            Some(0)
        );
        assert_eq!(
            parse_date_millis("1970-01-01T00:00:00Z", &|_| panic!("explicit UTC")),
            Some(0)
        );
        assert_eq!(parse_date_millis("1970-01-01T00:00:00", &|_| None), None);
        assert_eq!(
            parse_date_millis("1970-01-01T00:00:00", &|_| Some(i64::MIN)),
            None
        );

        // (millis, persisted ISO): extended years round trip; the time clip bounds both ways.
        for (millis, iso) in [
            (-8_640_000_000_000_000, "-271821-04-20T00:00:00.000Z"),
            (-62_198_755_200_000, "-000001-01-01T00:00:00.000Z"),
            (-62_167_219_200_000, "0000-01-01T00:00:00.000Z"),
            (-1, "1969-12-31T23:59:59.999Z"),
            (0, "1970-01-01T00:00:00.000Z"),
            (154_914_213_082_500, "6879-01-13T13:51:22.500Z"),
            (2_815_675_500_765_368, "+091195-03-16T19:32:45.368Z"),
        ] {
            assert_eq!(format_iso_millis(millis).as_deref(), Some(iso));
            assert_eq!(parse_iso_millis(iso), Some(millis));
        }
        assert_eq!(format_iso_millis(TIME_CLIP + 1), None);
        assert_eq!(format_iso_millis(-TIME_CLIP - 1), None);
        assert_eq!(format_date_value(f64::NAN), None);
        assert_eq!(format_date_value(f64::INFINITY), None);
        assert_eq!(format_date_value(TIME_CLIP as f64 + 1.0), None);
        assert_eq!(format_date_value(-0.5), format_iso_millis(0));
        assert_eq!(parse_iso_millis("2016-12-31T23:59:60.000Z"), None);
        assert_eq!(parse_iso_millis("invalid timestamp"), None);
        assert_eq!(parse_iso_millis("1970-01-01T09:00:00+09:00"), Some(0));
        assert_eq!(
            parse_iso_millis("2024-02-30T00:00:00.000Z"),
            Some(1_709_251_200_000)
        );
    }
}
