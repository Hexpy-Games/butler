//! `usageHistoryModel.ts`: the 53-week window of the heatmap and its shades.
use std::collections::HashMap;

use chrono::{Datelike as _, Days, NaiveDate};

const WEEKS: u64 = 53;
const DATE: &str = "%Y-%m-%d";

/// `HistoryMode`
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Mode {
    Daily,
    Weekly,
    Cumulative,
}

impl Mode {
    pub(super) fn key(self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Weekly => "weekly",
            Self::Cumulative => "cumulative",
        }
    }

    pub(super) fn of(key: &str) -> Self {
        match key {
            "weekly" => Self::Weekly,
            "cumulative" => Self::Cumulative,
            _ => Self::Daily,
        }
    }
}

/// What `historyWindow` returns.
pub(super) struct Window {
    pub(super) dates: Vec<String>,
    pub(super) values: Vec<f64>,
    pub(super) levels: Vec<u8>,
    pub(super) weeks: Vec<f64>,
    pub(super) cumulative: Vec<f64>,
    pub(super) weekly_heights: Vec<usize>,
    pub(super) cumulative_heights: Vec<usize>,
}

/// `dailyLevels`: 0 for none, 1 up to the median of the active days, then log thirds up to the busiest.
pub(super) fn daily_levels(values: &[f64]) -> Vec<u8> {
    let mut active: Vec<f64> = values.iter().copied().filter(|value| *value > 0.).collect();
    active.sort_by(f64::total_cmp);
    let middle = active.len() / 2;
    let median = match (active.len() % 2, active.get(middle)) {
        (1, Some(value)) => *value,
        (_, Some(upper)) => (active[middle - 1] + upper) / 2.,
        _ => 0.,
    };
    let max = active.last().copied().unwrap_or(0.);
    values
        .iter()
        .map(|&value| {
            if value <= 0. {
                return 0;
            }
            if value <= median || max == median {
                return 1;
            }
            let ratio = (value / median).ln() / (max / median).ln();
            // Exact log-third boundaries stay inclusive despite floating-point division.
            if ratio <= 1. / 3. + f64::EPSILON {
                2
            } else if ratio <= 2. / 3. + f64::EPSILON {
                3
            } else {
                4
            }
        })
        .collect()
}

/// How many of the 7 rows a share of the total fills.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "0 to 7"
)]
fn height(value: f64, total: f64) -> usize {
    if total > 0. {
        (7. * value / total).ceil() as usize
    } else {
        0
    }
}

/// `historyWindow`: 53 aligned columns, including the whole current week.
pub(super) fn window(
    days: &[(String, f64)],
    prior_total: f64,
    week_start: u32,
    today: NaiveDate,
) -> Window {
    let offset = (today.weekday().num_days_from_sunday() + 7 - week_start) % 7;
    let start = today
        .checked_sub_days(Days::new((WEEKS - 1) * 7 + u64::from(offset)))
        .unwrap_or(today);
    let dates: Vec<String> = (0..WEEKS * 7)
        .map(|index| {
            start
                .checked_add_days(Days::new(index))
                .unwrap_or(start)
                .format(DATE)
                .to_string()
        })
        .collect();
    let tokens: HashMap<&str, f64> = days
        .iter()
        .map(|(date, value)| (date.as_str(), *value))
        .collect();
    let today_key = today.format(DATE).to_string();
    let values: Vec<f64> = dates
        .iter()
        .map(|date| {
            if *date <= today_key {
                tokens.get(date.as_str()).copied().unwrap_or(0.)
            } else {
                0.
            }
        })
        .collect();
    let weeks: Vec<f64> = values.chunks(7).map(|week| week.iter().sum()).collect();
    let mut running = prior_total
        + days
            .iter()
            .filter(|(date, _)| *date < dates[0])
            .map(|(_, value)| value)
            .sum::<f64>();
    let cumulative: Vec<f64> = weeks
        .iter()
        .map(|value| {
            running += value;
            running
        })
        .collect();
    let max_week = weeks.iter().copied().fold(0., f64::max);
    Window {
        levels: daily_levels(&values),
        weekly_heights: weeks.iter().map(|value| height(*value, max_week)).collect(),
        cumulative_heights: cumulative
            .iter()
            .map(|value| height(*value, running))
            .collect(),
        dates,
        values,
        weeks,
        cumulative,
    }
}
