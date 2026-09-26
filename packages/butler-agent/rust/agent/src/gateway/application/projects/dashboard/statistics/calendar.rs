//! IANA timezone calendar boundaries used by dashboard statistics.

use std::path::{Component, Path};

use chrono::{DateTime, Datelike, NaiveDate, SecondsFormat, Utc};

use crate::gateway::GatewayApplicationError;

const DAY_MS: i64 = 86_400_000;

#[derive(Clone, Debug)]
pub(super) struct Day {
    pub date: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub partial: bool,
}

#[derive(Clone)]
pub(super) struct Calendar {
    pub days: Vec<Day>,
    pub observed_at: String,
    pub timezone: String,
}

pub(super) fn build(
    timezone: &str,
    period: u8,
    observed_at: String,
) -> Result<Calendar, GatewayApplicationError> {
    if timezone.is_empty() || timezone.len() > 100 || !matches!(period, 7 | 30 | 90) {
        return Err(invalid_statistics());
    }
    let zone = read_timezone(timezone)?;
    let now_ms = DateTime::parse_from_rfc3339(&observed_at)
        .map_err(|_| GatewayApplicationError::Internal)?
        .timestamp_millis();
    let today = local_date(&zone, now_ms)?;
    let today_days = parse_date(&today).ok_or(GatewayApplicationError::Internal)?;
    let labels = (0..=period)
        .map(|offset| date_string(today_days + i64::from(offset) - i64::from(period) + 1))
        .collect::<Vec<_>>();
    let boundaries = labels
        .iter()
        .map(|date| local_date_boundary(&zone, date))
        .collect::<Result<Vec<_>, _>>()?;
    let days = labels
        .into_iter()
        .take(usize::from(period))
        .enumerate()
        .map(|(index, date)| Day {
            partial: date == today,
            date,
            start_ms: boundaries[index],
            end_ms: boundaries[index + 1].min(now_ms),
        })
        .collect();
    Ok(Calendar {
        days,
        observed_at,
        timezone: timezone.to_owned(),
    })
}

pub(super) fn iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}

fn read_timezone(value: &str) -> Result<tz::TimeZone, GatewayApplicationError> {
    if value == "UTC" {
        return Ok(tz::TimeZone::utc());
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(invalid_timezone());
    }
    let path = Path::new("/usr/share/zoneinfo").join(path);
    let bytes = std::fs::read(path).map_err(|_| invalid_timezone())?;
    let mut zone = tz::TimeZone::from_tz_data(&bytes).map_err(|_| invalid_timezone())?;
    let view = zone.as_ref();
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
        .map_err(|_| invalid_timezone())?;
    }
    Ok(zone)
}

fn local_date(zone: &tz::TimeZone, epoch_ms: i64) -> Result<String, GatewayApplicationError> {
    let offset = zone
        .find_local_time_type(epoch_ms.div_euclid(1_000))
        .map_err(|_| invalid_timezone())?
        .ut_offset();
    let local_ms = epoch_ms + i64::from(offset) * 1_000;
    let days = local_ms.div_euclid(DAY_MS);
    Ok(date_string(days))
}

fn local_date_boundary(zone: &tz::TimeZone, date: &str) -> Result<i64, GatewayApplicationError> {
    let nominal = parse_date(date).ok_or_else(invalid_timezone)? * DAY_MS;
    let mut low = nominal - 36 * 60 * 60 * 1_000;
    let mut high = nominal + 36 * 60 * 60 * 1_000;
    while low < high {
        let middle = low + (high - low) / 2;
        if local_date(zone, middle)?.as_str() < date {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    Ok(low)
}

fn parse_date(value: &str) -> Option<i64> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
    Some(i64::from(date.num_days_from_ce() - 719_163))
}

fn date_string(days: i64) -> String {
    let (year, month, day) = crate::js_date::civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

fn invalid_statistics() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 400,
        code: "invalid_statistics_query".into(),
        message: "Invalid statistics query.".into(),
    }
}

fn invalid_timezone() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 400,
        code: "invalid_timezone".into(),
        message: "Invalid timezone.".into(),
    }
}
