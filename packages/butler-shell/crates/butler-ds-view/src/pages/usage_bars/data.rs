//! UsageBars.showcaseData.ts: the copy, the series and the deterministic sample usage. Dates are
//! wall-clock (see `butler_ds::ui::blocks::usage_bars`); the formats are `Intl`'s for en-US and
//! ko-KR.
use butler_ds::ui::blocks::usage_bars::{
    AxisLabel, Bucket, BucketOptions, Bucketing, SLOT_MS, Segment, Series, SeriesColor, Slot,
    bucket_usage_slots, civil_from_days, day_and_hour, wall_ms,
};
use gpui::SharedString;

use crate::copy::Lang;

pub(super) struct Copy {
    pub new_input: &'static str,
    pub cached: &'static str,
    pub output: &'static str,
    pub just_started: &'static str,
    pub no_usage: &'static str,
    pub no_usage_period: &'static str,
    pub today: &'static str,
    pub total: &'static str,
    pub add: &'static str,
    pub replay: &'static str,
    pub range: &'static str,
    pub conversation: &'static str,
    pub subtask: &'static str,
    pub add_subtask: &'static str,
}

pub(super) fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            new_input: "New input",
            cached: "Cached",
            output: "Output",
            just_started: "Just started",
            no_usage: "No usage yet",
            no_usage_period: "No usage in this period",
            today: "Today",
            total: "Total",
            add: "Add a response",
            replay: "Replay",
            range: "Switch range",
            conversation: "Conversation",
            subtask: "Subtask",
            add_subtask: "Add a subtask response",
        },
        Copy {
            new_input: "새 입력",
            cached: "캐시",
            output: "출력",
            just_started: "방금 시작",
            no_usage: "아직 사용량이 없습니다",
            no_usage_period: "이 기간에 사용량이 없습니다",
            today: "오늘",
            total: "합계",
            add: "응답 추가",
            replay: "다시 재생",
            range: "기간 바꾸기",
            conversation: "대화",
            subtask: "하위 작업",
            add_subtask: "하위 작업 응답 추가",
        },
    )
}

pub(super) fn series(lang: Lang) -> Vec<Series> {
    let c = copy(lang);
    [
        ("new", SeriesColor::Chart1, c.new_input),
        ("cached", SeriesColor::Chart5, c.cached),
        ("output", SeriesColor::Chart2, c.output),
    ]
    .into_iter()
    .map(|(id, color, label)| Series {
        id: id.into(),
        color,
        label: label.into(),
    })
    .collect()
}

/// `Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 })`.
pub(super) fn compact_tokens(lang: Lang, value: f64) -> String {
    let units: &[(f64, &str)] = match lang {
        Lang::En => &[(1e9, "B"), (1e6, "M"), (1e3, "K")],
        Lang::Ko => &[(1e8, "억"), (1e4, "만"), (1e3, "천")],
    };
    let Some((unit, suffix)) = units.iter().find(|(unit, _)| value >= *unit) else {
        return format!("{value:.0}");
    };
    let scaled = (value / unit * 10.).round() / 10.;
    if scaled.fract() == 0. {
        format!("{scaled:.0}{suffix}")
    } else {
        format!("{scaled:.1}{suffix}")
    }
}

/// 15:32 on Oct 15, 2026, the sample "now".
pub(super) fn now() -> i64 {
    wall_ms(2026, 10, 15, 15, 32)
}

const HOUR: i64 = 3_600_000;

/// Deterministic 15-minute slots [new, cached, output] over `hours` before now, active in working
/// hours.
pub(super) fn sample_slots(hours: i64, seed: i64) -> Vec<Slot> {
    let first = now() - hours * HOUR;
    let mut slots = Vec::new();
    let mut start = first - first.rem_euclid(SLOT_MS);
    while start < now() {
        let hour = day_and_hour(start).1;
        let index = ((start - first) as f64 / SLOT_MS as f64).round() as i64;
        let wave = ((index * 37 + seed * 11).rem_euclid(23)) as f64 / 23.;
        if (9..=22).contains(&hour) && wave >= 0.45 {
            let prompt = (40_000. + wave * 260_000.).round();
            slots.push(Slot {
                start,
                values: vec![
                    (prompt * 0.12).round(),
                    (prompt * 0.88).round(),
                    (prompt * 0.03).round(),
                ],
            });
        }
        start += SLOT_MS;
    }
    slots
}

/// A delegating chat: each slot also carries its subtask part per type.
pub(super) fn sample_split_slots(hours: i64, seed: i64) -> Vec<Slot> {
    sample_slots(hours, seed)
        .into_iter()
        .enumerate()
        .map(|(index, slot)| {
            let share = [0., 0.3, 0.55, 0.7, 0.15, 0.45][(index + seed as usize) % 6];
            let [fresh, cached, output] = [slot.values[0], slot.values[1], slot.values[2]];
            let mut values = slot.values;
            values.extend([
                (fresh * share * 0.8).round(),
                (cached * share).round(),
                (output * share * 1.2).round(),
            ]);
            Slot {
                start: slot.start,
                values,
            }
        })
        .collect()
}

fn month_day(ms: i64) -> (i64, i64) {
    let (_, month, day) = civil_from_days(day_and_hour(ms).0);
    (month, day)
}

/// `Intl.DateTimeFormat(locale, { hour: "numeric" })`.
fn hour_text(lang: Lang, ms: i64) -> String {
    let hour = day_and_hour(ms).1;
    let twelve = if hour % 12 == 0 { 12 } else { hour % 12 };
    match lang {
        Lang::En => format!("{twelve} {}", if hour < 12 { "AM" } else { "PM" }),
        Lang::Ko => format!("{} {twelve}시", if hour < 12 { "오전" } else { "오후" }),
    }
}

fn bucket_label(lang: Lang, bucketing: &Bucketing, ms: i64) -> String {
    let (month, day) = month_day(ms);
    let hourly = bucketing.step_hours < 24;
    match lang {
        Lang::En => {
            const NAMES: [&str; 12] = [
                "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            ];
            let date = format!("{} {day}", NAMES[(month - 1) as usize]);
            if hourly {
                format!("{date}, {}", hour_text(lang, ms))
            } else {
                date
            }
        }
        Lang::Ko => {
            let date = format!("{month}월 {day}일");
            if hourly {
                format!("{date} {}", hour_text(lang, ms))
            } else {
                date
            }
        }
    }
}

pub(super) fn to_buckets(lang: Lang, bucketing: &Bucketing) -> Vec<Bucket> {
    bucketing
        .buckets
        .iter()
        .map(|bucket| {
            let value = |index: usize| bucket.values.get(index).copied().unwrap_or(0.);
            let sub = |index: usize| bucket.values.get(index).copied().unwrap_or(0.);
            let total = value(0) + value(1) + value(2);
            let tokens = compact_tokens(lang, total);
            Bucket {
                key: bucket.start.to_string().into(),
                segments: ["new", "cached", "output"]
                    .into_iter()
                    .enumerate()
                    .map(|(index, id)| Segment {
                        id: id.into(),
                        value: value(index),
                        subtask: sub(index + 3),
                    })
                    .collect(),
                label: bucket_label(lang, bucketing, bucket.start).into(),
                value_text: lang
                    .pick(format!("{tokens} tokens"), format!("{tokens} 토큰"))
                    .into(),
            }
        })
        .collect()
}

/// Hourly: first and last hour. Sub-day steps: each midnight. Days: every 7th day back from the last.
pub(super) fn axis_labels(lang: Lang, bucketing: &Bucketing) -> Vec<AxisLabel> {
    let buckets = &bucketing.buckets;
    let c = copy(lang);
    if buckets.is_empty() {
        return Vec::new();
    }
    if bucketing.step_hours == 1 && buckets.len() <= 24 {
        let ends: Vec<usize> = if buckets.len() > 1 {
            vec![0, buckets.len() - 1]
        } else {
            vec![0]
        };
        return ends
            .into_iter()
            .map(|index| AxisLabel {
                index,
                text: hour_text(lang, buckets[index].start).into(),
            })
            .collect();
    }
    buckets
        .iter()
        .enumerate()
        .filter_map(|(index, bucket)| {
            let show = if bucketing.step_hours < 24 {
                day_and_hour(bucket.start).1 == 0
            } else {
                (buckets.len() - 1 - index) % 7 == 0
            };
            show.then(|| {
                let (month, day) = month_day(bucket.start);
                let text: SharedString = if index == buckets.len() - 1 {
                    c.today.into()
                } else {
                    lang.pick(format!("{month}/{day}"), format!("{month}. {day}."))
                        .into()
                };
                AxisLabel { index, text }
            })
        })
        .collect()
}

/// A ready-to-render chart.
pub(super) struct Chart {
    pub buckets: Vec<Bucket>,
    pub axis_labels: Vec<AxisLabel>,
}

fn chart_of(lang: Lang, bucketing: &Bucketing) -> Chart {
    Chart {
        buckets: to_buckets(lang, bucketing),
        axis_labels: axis_labels(lang, bucketing),
    }
}

/// `slots` bucketed over the `hours` before now (the usage tab's fixed window).
pub(super) fn window_chart(
    lang: Lang,
    slots: &[Slot],
    hours: i64,
    max_bars: Option<usize>,
) -> Chart {
    let bucketing = bucket_usage_slots(
        slots,
        BucketOptions {
            from: Some(now() - hours * HOUR),
            to: Some(now()),
            max_bars,
        },
    );
    chart_of(lang, &bucketing)
}

/// Chat usage since the chat's first slot (the popover case).
pub(super) fn chat_chart(lang: Lang, slots: &[Slot]) -> Chart {
    let bucketing = bucket_usage_slots(
        slots,
        BucketOptions {
            to: Some(now()),
            ..BucketOptions::default()
        },
    );
    chart_of(lang, &bucketing)
}
