//! `usage/usageTimeline.ts` and `usage/compactTokens.ts`: the popover's usage bars, readout values
//! and the conversation / subtask split of one chat's usage.
use butler_ds::ui::blocks::usage_bars::{
    AxisLabel, Bucket as BarBucket, BucketOptions, Emphasis, Segment, Series, SeriesColor, Slot,
    TimeBucket, bucket_usage_slots, day_and_hour,
};
use butler_ds::ui::context::Lang;

use super::usage::{UsageMonitorView, clock, local_offset_ms, month_day, parse_ms};
use crate::ui::i18n::composer::usage::{UsageCopy, copy};

/// Values after the start of a slot that carries its subtask requests, cached and output;
/// shorter slots have no per-type split.
const SPLIT_SLOT_VALUES: usize = 8;

/// `usageSeries`.
pub(super) fn usage_series(c: &UsageCopy) -> Vec<Series> {
    vec![
        Series {
            id: "new".into(),
            color: SeriesColor::Chart1,
            label: c.new_input.into(),
        },
        Series {
            id: "cache".into(),
            color: SeriesColor::Chart5,
            label: c.cached.into(),
        },
        Series {
            id: "output".into(),
            color: SeriesColor::Chart2,
            label: c.output.into(),
        },
    ]
}

/// `trim`ed fixed-point text: "12.3", "12".
fn fixed(value: f64, decimals: usize) -> String {
    let text = format!("{value:.decimals$}");
    if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.').to_owned()
    } else {
        text
    }
}

/// `compactTokens`: 12.3K / 1.2만, never Latin units for Korean.
pub(super) fn usage_tokens(value: f64, lang: Lang) -> String {
    let amount = value.max(0.).round();
    if amount < 1000. {
        return fixed(amount, 0);
    }
    let korean = lang == Lang::Ko;
    let units: &[(f64, &str)] = if korean {
        &[(1e8, "억"), (1e4, "만"), (1e3, "천")]
    } else {
        &[(1e9, "B"), (1e6, "M"), (1e3, "K")]
    };
    let decimals = |scaled: f64| {
        if korean {
            usize::from(scaled < 100.)
        } else if scaled >= 100. {
            0
        } else {
            1 + usize::from(scaled < 10.)
        }
    };
    let rounded = |scaled: f64| {
        let factor = 10f64.powi(i32::try_from(decimals(scaled)).unwrap_or(0));
        (scaled * factor).round() / factor
    };
    let mut index = units
        .iter()
        .position(|(threshold, _)| amount >= *threshold)
        .unwrap_or(units.len() - 1);
    while index > 0 && rounded(amount / units[index].0) * units[index].0 >= units[index - 1].0 {
        index -= 1;
    }
    let (divisor, suffix) = units[index];
    let scaled = amount / divisor;
    format!("{}{suffix}", fixed(scaled, decimals(scaled)))
}

pub(super) struct TimelineBucket {
    pub(super) values: Vec<f64>,
    pub(super) requests: f64,
    pub(super) prompt: f64,
    pub(super) cached: f64,
    pub(super) output: f64,
    pub(super) delegated: f64,
    pub(super) total: f64,
    pub(super) label: String,
    pub(super) bar: BarBucket,
}

pub(super) struct Timeline {
    pub(super) buckets: Vec<TimelineBucket>,
    pub(super) axis_labels: Vec<AxisLabel>,
    pub(super) step_hours: u32,
}

/// `usageBucketLabel`; `start` and `end` are wall-clock milliseconds.
fn bucket_label(start: i64, end: i64, now: i64, step_hours: u32, lang: Lang) -> String {
    let c = copy(lang);
    let same_day = day_and_hour(start).0 == day_and_hour(now).0;
    let end_hour = match day_and_hour(end).1 {
        0 => 24,
        hour => hour,
    };
    let time = if step_hours < 24 {
        (c.bucket_hours)(day_and_hour(start).1, end_hour, same_day && step_hours == 1)
    } else {
        String::new()
    };
    let date = if !same_day || step_hours >= 24 {
        month_day(start, lang)
    } else {
        String::new()
    };
    let label = [date, time]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let current = if start <= now && now < end { c.now } else { "" };
    [label.as_str(), current]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
}

fn axis_labels(
    buckets: &[TimelineBucket],
    starts: &[i64],
    now: i64,
    step: u32,
    lang: Lang,
) -> Vec<AxisLabel> {
    let Some(last) = buckets.len().checked_sub(1) else {
        return Vec::new();
    };
    let mut indices = vec![0, last / 2, last];
    indices.dedup();
    indices
        .into_iter()
        .map(|index| {
            let start = starts[index];
            let text = if step < 24 {
                let other_day = day_and_hour(start).0 != day_and_hour(now).0;
                let date = if other_day {
                    format!("{} ", month_day(start, lang))
                } else {
                    String::new()
                };
                format!("{date}{}", clock(start))
            } else {
                month_day(start, lang)
            };
            AxisLabel {
                index,
                text: text.into(),
            }
        })
        .collect()
}

fn at<T: Copy + Default>(values: &[T], index: usize) -> T {
    values.get(index).copied().unwrap_or_default()
}

/// One grouped bucket with its readout values and its bar.
fn timeline_bucket(
    bucket: &TimeBucket,
    scoped: bool,
    now: i64,
    step_hours: u32,
    lang: Lang,
) -> TimelineBucket {
    let c = copy(lang);
    let v = &bucket.values;
    let (requests, prompt, cached, output) = (at(v, 0), at(v, 1), at(v, 2), at(v, 3));
    let (delegated, d_cached, d_output) = (at(v, 4), at(v, 6), at(v, 7));
    let split = scoped && delegated > 0. && v.len() >= SPLIT_SLOT_VALUES;
    let segment = |id: &str, value: f64, subtask: f64| Segment {
        id: id.to_owned().into(),
        value,
        subtask: if split { subtask } else { 0. },
    };
    let label = bucket_label(bucket.start, bucket.end, now, step_hours, lang);
    let bar = BarBucket {
        key: bucket.start.to_string().into(),
        label: label.clone().into(),
        value_text: format!("{} {}", usage_tokens(prompt + output, lang), c.tokens).into(),
        segments: vec![
            segment(
                "new",
                (prompt - cached).max(0.),
                (delegated - d_output - d_cached).max(0.),
            ),
            segment("cache", cached, d_cached),
            segment("output", output, d_output),
        ],
    };
    TimelineBucket {
        values: v.clone(),
        requests,
        prompt,
        cached,
        output,
        delegated,
        total: prompt + output,
        label,
        bar,
    }
}

/// `usageTimeline`.
pub(super) fn usage_timeline(
    view: Option<&UsageMonitorView>,
    max_bars: usize,
    lang: Lang,
) -> Timeline {
    let offset = local_offset_ms();
    let now = view
        .and_then(|v| parse_ms(&v.generated_at))
        .map_or(0, |ms| ms + offset);
    #[expect(
        clippy::cast_possible_truncation,
        reason = "epoch milliseconds are whole numbers well inside i64"
    )]
    let wall = |ms: f64| ms as i64 + offset;
    let slots: Vec<Slot> = view
        .map(|v| {
            v.timeline
                .slots
                .iter()
                .filter_map(|slot| {
                    Some(Slot {
                        start: wall(*slot.first()?),
                        values: slot[1..].to_vec(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let grouped = bucket_usage_slots(
        &slots,
        BucketOptions {
            from: view.and_then(|v| v.filters.since_ts).map(wall),
            to: view.map(|v| v.filters.until_ts.map_or(now, wall)),
            max_bars: Some(max_bars),
        },
    );
    // Only one chat's usage splits by who made the calls; all-chats bars stay solid.
    let scoped = view.is_some_and(|v| v.filters.session_id.is_some());
    let starts: Vec<i64> = grouped.buckets.iter().map(|b| b.start).collect();
    let buckets: Vec<TimelineBucket> = grouped
        .buckets
        .iter()
        .map(|bucket| timeline_bucket(bucket, scoped, now, grouped.step_hours, lang))
        .collect();
    let axis = axis_labels(&buckets, &starts, now, grouped.step_hours, lang);
    Timeline {
        buckets,
        axis_labels: axis,
        step_hours: grouped.step_hours,
    }
}

/// `usageReadout`'s values.
pub(super) struct Readout {
    pub(super) requests: f64,
    pub(super) prompt: f64,
    pub(super) cached: f64,
    pub(super) output: f64,
    pub(super) total: f64,
}

pub(super) fn usage_readout(
    view: Option<&UsageMonitorView>,
    bucket: Option<&TimelineBucket>,
) -> Readout {
    if let Some(b) = bucket {
        return Readout {
            requests: b.requests,
            prompt: b.prompt,
            cached: b.cached,
            output: b.output,
            total: b.total,
        };
    }
    let totals = view.map(|v| &v.model.totals);
    let prompt = totals.map_or(0., |t| t.prompt_tokens);
    let total = totals.map_or(0., |t| t.total_tokens);
    Readout {
        requests: totals.map_or(0., |t| t.request_count),
        prompt,
        cached: totals.map_or(0., |t| t.cached_tokens),
        output: (total - prompt).max(0.),
        total,
    }
}

/// `usageShare`.
fn usage_share(value: f64, lang: Lang) -> String {
    if value > 0. && value < 0.01 {
        return copy(lang).tiny_share.to_owned();
    }
    format!("{}%", fixed((value * 1000.).round() / 10., 1))
}

/// One row of the total's split by who made the calls.
pub(super) struct Part {
    pub(super) id: &'static str,
    pub(super) emphasis: Emphasis,
    pub(super) label: &'static str,
    pub(super) value: String,
}

/// `usageParts`: the chat total split into its own calls and its delegated work; `None` when
/// nothing was delegated, or when the response lacks the values for an honest split.
pub(super) fn usage_parts(
    view: Option<&UsageMonitorView>,
    bucket: Option<&TimelineBucket>,
    lang: Lang,
) -> Option<Vec<Part>> {
    let view = view?;
    let subtasks = view
        .model
        .subtasks
        .as_ref()
        .filter(|s| s.total_tokens > 0.)?;
    if bucket.is_some_and(|b| b.values.len() < SPLIT_SLOT_VALUES) {
        return None;
    }
    // Both parts share one basis: the view's totals for the chat, the slot's prompt + output for a bar.
    let (whole, delegated) = bucket.map_or(
        (view.model.totals.total_tokens, subtasks.total_tokens),
        |b| (b.total, b.delegated),
    );
    let main = (whole - delegated).max(0.);
    let total = main + delegated;
    let c = copy(lang);
    let part = |id, emphasis, label, value: f64| Part {
        id,
        emphasis,
        label,
        value: [
            Some(usage_tokens(value, lang)),
            (total > 0.).then(|| usage_share(value / total, lang)),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · "),
    };
    Some(vec![
        part("main", Emphasis::Conversation, c.conversation_part, main),
        part("delegated", Emphasis::Subtask, c.delegated_part, delegated),
    ])
}
