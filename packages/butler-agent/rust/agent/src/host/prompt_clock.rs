//! Native fixed en-US prompt time formatting. The formatter owns immutable
//! locale data; timezone transitions are borrowed from the compiled database.

use crate::context::{ContextError, ContextResult, PromptClock};

mod timezone_names;
use super::timezone_data::TimeZoneData;
use timezone_names::TimeZoneNames;

pub(crate) struct NativePromptClock {
    names: TimeZoneNames,
    transitions: TimeZoneData,
}

impl NativePromptClock {
    pub(crate) fn new() -> ContextResult<Self> {
        Ok(Self {
            names: TimeZoneNames::new()?,
            transitions: TimeZoneData::new()?,
        })
    }

    fn local_time(&self, value: i64, timezone: &str) -> ContextResult<String> {
        if value.unsigned_abs() > 8_640_000_000_000_000 {
            return Err(failure("Date is outside TimeClip"));
        }
        let (offset, daylight, canonical) = match fixed_offset(timezone) {
            Some(offset) => (
                offset,
                false,
                if offset == 0 { Some("Etc/GMT") } else { None },
            ),
            None => {
                let (offset, daylight, canonical) =
                    self.transitions.facts(timezone, value.div_euclid(1000))?;
                (offset, daylight, Some(canonical))
            }
        };
        let local = value + i64::from(offset) * 1000;
        let days = local.div_euclid(86_400_000);
        let seconds = local.rem_euclid(86_400_000) / 1000;
        let (year, month, day) = crate::js_date::civil_from_days(days);
        let hour = seconds / 3600;
        let minute = seconds / 60 % 60;
        let second = seconds % 60;
        let label = canonical.and_then(|name| self.names.specific(name, value, daylight));
        let fallback;
        let label = match label {
            Some(label) => label,
            None => {
                fallback = if offset == 0 {
                    "GMT+0".into()
                } else {
                    short_gmt(offset)
                };
                &fallback
            }
        };
        const WEEKDAYS: [&str; 7] = [
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
        ];
        const MONTHS: [&str; 12] = [
            "January",
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "August",
            "September",
            "October",
            "November",
            "December",
        ];
        // PromptAssembler fixes en-US/full/long: its pattern is constant and
        // uses ordinary spaces. No user locale or host locale is substituted.
        Ok(format!(
            "{}, {} {day}, {} at {}:{minute:02}:{second:02} {} {label}",
            WEEKDAYS[usize::try_from((days + 4).rem_euclid(7)).unwrap_or_default()],
            MONTHS[usize::try_from(month - 1).unwrap_or_default()],
            if year <= 0 { 1 - year } else { year },
            if hour % 12 == 0 { 12 } else { hour % 12 },
            if hour < 12 { "AM" } else { "PM" },
        ))
    }
}

impl PromptClock for NativePromptClock {
    fn now_epoch_millis(&self) -> i64 {
        crate::models::ModelConfigurationClock::now_epoch_millis(&super::SystemIdentity)
    }

    fn parse_timestamp(&self, value: &str) -> Option<i64> {
        crate::js_date::parse_iso_millis(value)
    }

    fn iso_from_epoch_millis(&self, value: i64) -> ContextResult<String> {
        crate::js_date::format_iso_millis(value).ok_or_else(|| failure("Date is outside TimeClip"))
    }

    fn format_local_time(&self, value: i64, timezone: &str) -> ContextResult<String> {
        self.local_time(value, timezone)
    }
}

fn fixed_offset(value: &str) -> Option<i32> {
    let bytes = value.as_bytes();
    let sign = match bytes.first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let pair = |digits: &[u8]| -> Option<i32> {
        (digits.len() == 2 && digits.iter().all(u8::is_ascii_digit))
            .then(|| i32::from(digits[0] - b'0') * 10 + i32::from(digits[1] - b'0'))
    };
    let (hour, minute) = match bytes.len() {
        3 => (pair(&bytes[1..3])?, 0),
        5 => (pair(&bytes[1..3])?, pair(&bytes[3..5])?),
        6 if bytes[3] == b':' => (pair(&bytes[1..3])?, pair(&bytes[4..6])?),
        _ => return None,
    };
    (hour < 24 && minute < 60).then_some(sign * (hour * 3600 + minute * 60))
}

fn short_gmt(offset: i32) -> String {
    if offset == 0 {
        return "GMT".into();
    }
    let sign = if offset < 0 { '-' } else { '+' };
    let absolute = offset.unsigned_abs();
    let hour = absolute / 3600;
    let minute = absolute / 60 % 60;
    let second = absolute % 60;
    if second != 0 {
        format!("GMT{sign}{hour}:{minute:02}:{second:02}")
    } else if minute != 0 {
        format!("GMT{sign}{hour}:{minute:02}")
    } else {
        format!("GMT{sign}{hour}")
    }
}

fn failure(message: impl Into<String>) -> ContextError {
    ContextError::new("prompt_time_format_error", message)
}

#[cfg(test)]
mod tests;
