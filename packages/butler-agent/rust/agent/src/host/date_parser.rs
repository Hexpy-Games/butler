//! One host-bound process timezone, independent of the user's prompt timezone.
//! Parsing retains no input, cache, or date history. Host composition supplies
//! the process timezone explicitly; there is no silent UTC fallback.

use super::timezone_data::TimeZoneData;
use crate::context::{ContextError, ContextResult};

pub(crate) struct NativeDateParser {
    zone: tz::TimeZone,
}

impl NativeDateParser {
    /// Capture the process timezone once. An explicit TZ uses the same compiled
    /// zone rules as named-zone callers; otherwise use the OS localtime file.
    pub(crate) fn from_process() -> ContextResult<Self> {
        if let Some(value) = std::env::var_os("TZ") {
            let value = value
                .to_str()
                .ok_or_else(|| ContextError::new("date_timezone_unavailable", "TZ is not UTF-8"))?;
            if value.is_empty() {
                return Self::from_zone(tz::TimeZone::utc());
            }
            let value = value.strip_prefix(':').unwrap_or(value);
            if !std::path::Path::new(value).is_absolute() {
                return Self::new(value);
            }
            return Self::from_zone_file(std::path::Path::new(value));
        }
        Self::from_zone_file(std::path::Path::new("/etc/localtime"))
    }

    fn from_zone_file(path: &std::path::Path) -> ContextResult<Self> {
        let bytes = std::fs::read(path)
            .map_err(|error| ContextError::new("date_timezone_unavailable", error.to_string()))?;
        let zone = tz::TimeZone::from_tz_data(&bytes)
            .map_err(|error| ContextError::new("date_timezone_unavailable", error.to_string()))?;
        Self::from_zone(zone)
    }

    pub(crate) fn new(process_timezone: &str) -> ContextResult<Self> {
        let data = TimeZoneData::new()?;
        Self::from_zone(data.find(process_timezone)?)
    }

    fn from_zone(mut zone: tz::TimeZone) -> ContextResult<Self> {
        let view = zone.as_ref();
        // ICU retains the last offset, including permanent DST. TZif without
        // a footer does not express that extrapolation to tz-rs::find.
        if view.extra_rule().is_none()
            && let Some(last) = view.transitions().last()
        {
            let fixed = view.local_time_types()[last.local_time_type_index()];
            zone = tz::TimeZone::new(
                view.transitions().to_vec(),
                view.local_time_types().to_vec(),
                view.leap_seconds().to_vec(),
                Some(tz::timezone::TransitionRule::Fixed(fixed)),
            )
            .map_err(|error| ContextError::new("date_timezone_unavailable", error.to_string()))?;
        }
        Ok(Self { zone })
    }

    pub(crate) fn parse(&self, text: &str) -> Option<i64> {
        crate::js_date::parse_date_millis(text, &|wall| self.local_to_utc(wall))
    }

    pub(crate) fn local_day_and_minute(&self, epoch_ms: i64) -> ContextResult<(String, u16)> {
        let seconds = epoch_ms.div_euclid(1_000);
        let offset = self
            .zone
            .find_local_time_type(seconds)
            .map_err(|error| ContextError::new("date_timezone_unavailable", error.to_string()))?
            .ut_offset();
        let wall = epoch_ms + i64::from(offset) * 1_000;
        let (year, month, day) = crate::js_date::civil_from_days(wall.div_euclid(86_400_000));
        let minute = (wall.rem_euclid(86_400_000) / 60_000) as u16;
        Ok((format!("{year:04}-{month:02}-{day:02}"), minute))
    }

    fn local_to_utc(&self, wall: i64) -> Option<i64> {
        let (year, month, day) = crate::js_date::civil_from_days(wall.div_euclid(86_400_000));
        let seconds = wall.rem_euclid(86_400_000) / 1000;
        // find_n records candidates in UTC order. Only the earliest is needed:
        // ICU uses the former offset for both a fold and a skipped wall time.
        let mut first = [None];
        let found = tz::DateTime::find_n(
            &mut first,
            year.try_into().ok()?,
            month.try_into().ok()?,
            day.try_into().ok()?,
            (seconds / 3600) as u8,
            (seconds / 60 % 60) as u8,
            (seconds % 60) as u8,
            0,
            self.zone.as_ref(),
        )
        .ok()?;
        let offset = found.earliest()?.local_time_type().ut_offset();
        wall.checked_sub(i64::from(offset) * 1000)
    }
}

#[cfg(test)]
mod tests;
