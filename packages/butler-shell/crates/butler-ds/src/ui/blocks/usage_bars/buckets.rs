//! usageBuckets.ts and usageBucketGrid.ts: adaptive time bucketing for UsageBars. 15-minute usage
//! slots become at most `max_bars` buckets of one shared step, aligned to wall-clock time. Pure:
//! no clock reads. Times are wall-clock milliseconds (the local calendar read as if it were UTC),
//! so a bucket start is a local time without a time-zone database; a daylight-saving change is
//! not modelled (the React grid lengthens or shortens only the bucket it falls in).

/// Bucket steps in hours, smallest first: 1, 2, 3, 6, 12 hours, then 1, 2 and 7 days.
const STEPS: [u32; 8] = [1, 2, 3, 6, 12, 24, 48, 168];
/// Length of one input slot.
pub const SLOT_MS: i64 = 15 * 60 * 1000;
const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 86_400_000;
const DEFAULT_MAX_BARS: usize = 24;
/// Monday.
const DEFAULT_WEEK_START: i64 = 1;

/// One 15-minute slot: its start and its values (requests, tokens, ...).
#[derive(Clone, Debug)]
pub struct Slot {
    pub start: i64,
    pub values: Vec<f64>,
}

#[derive(Clone, Debug)]
pub struct TimeBucket {
    pub start: i64,
    pub end: i64,
    pub values: Vec<f64>,
}

#[derive(Clone, Debug)]
pub struct Bucketing {
    pub step_hours: u32,
    pub buckets: Vec<TimeBucket>,
}

/// `bucketUsageSlots` options.
#[derive(Clone, Copy, Debug, Default)]
pub struct Options {
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub max_bars: Option<usize>,
}

/// Days since 1970-01-01 of a civil date (proleptic Gregorian).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The civil date (year, month 1 to 12, day) of days since 1970-01-01.
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Wall-clock milliseconds of a local date and time.
pub fn wall_ms(year: i64, month: i64, day: i64, hour: i64, minute: i64) -> i64 {
    days_from_civil(year, month, day) * DAY_MS + hour * HOUR_MS + minute * 60_000
}

/// Local day number and hour of a wall-clock time.
pub fn day_and_hour(ms: i64) -> (i64, i64) {
    (ms.div_euclid(DAY_MS), ms.rem_euclid(DAY_MS) / HOUR_MS)
}

/// Day of the week, 0 Sunday to 6 Saturday, of a day number.
fn weekday(day: i64) -> i64 {
    (day + 4).rem_euclid(7)
}

/// The start of the bucket of `step` hours that contains `ms`. Sub-day steps align to multiples
/// of the step from midnight; 7-day steps to Monday; other multi-day steps to a fixed grid (day
/// number modulo the step), so a rolling window keeps the same boundaries from day to day.
fn aligned_start(ms: i64, step: u32) -> i64 {
    let (day, hour) = day_and_hour(ms);
    let step = i64::from(step);
    if step < 24 {
        return day * DAY_MS + hour / step * step * HOUR_MS;
    }
    let days = step / 24;
    let day = if days == 7 {
        day - (weekday(day) - DEFAULT_WEEK_START).rem_euclid(7)
    } else {
        day - day.rem_euclid(days)
    };
    day * DAY_MS
}

struct Grid {
    starts: Vec<i64>,
    end: i64,
}

/// Bucket starts covering [from, to); stops early once more than `limit` are needed.
fn grid(from: i64, to: i64, step: u32, limit: usize) -> Grid {
    let first = aligned_start(from, step);
    let mut starts = Vec::new();
    let mut k = 0;
    while starts.len() <= limit {
        let start = first + k * i64::from(step) * HOUR_MS;
        k += 1;
        if start >= to {
            return Grid { starts, end: start };
        }
        starts.push(start);
    }
    Grid {
        starts,
        end: i64::MAX,
    }
}

fn window(slots: &[Slot], options: &Options) -> Option<(i64, i64)> {
    if let (Some(from), Some(to)) = (options.from, options.to) {
        return Some((from, to));
    }
    let first = slots.iter().map(|slot| slot.start).min()?;
    let last = slots.iter().map(|slot| slot.start).max()?;
    Some((
        options.from.unwrap_or(first),
        options.to.unwrap_or(last + SLOT_MS),
    ))
}

/// Groups slots into the smallest step whose bucket count is at most `max_bars` (7 days when
/// none fits). Slots outside [from, to) are left out.
pub fn bucket_usage_slots(slots: &[Slot], options: Options) -> Bucketing {
    let Some((from, to)) = window(slots, &options).filter(|(from, to)| to > from) else {
        return Bucketing {
            step_hours: STEPS[0],
            buckets: Vec::new(),
        };
    };
    let max_bars = options.max_bars.unwrap_or(DEFAULT_MAX_BARS).max(1);
    let mut step = STEPS[0];
    let mut found = Grid {
        starts: Vec::new(),
        end: to,
    };
    for candidate in STEPS {
        step = candidate;
        found = grid(
            from,
            to,
            candidate,
            if candidate == 168 {
                usize::MAX - 1
            } else {
                max_bars
            },
        );
        if found.starts.len() <= max_bars {
            break;
        }
    }
    let width = slots
        .iter()
        .map(|slot| slot.values.len())
        .max()
        .unwrap_or(0);
    let mut buckets: Vec<TimeBucket> = found
        .starts
        .iter()
        .enumerate()
        .map(|(index, start)| TimeBucket {
            start: *start,
            end: found.starts.get(index + 1).copied().unwrap_or(found.end),
            values: vec![0.; width],
        })
        .collect();
    for slot in slots
        .iter()
        .filter(|slot| slot.start >= from && slot.start < to)
    {
        let index = found.starts.partition_point(|start| *start <= slot.start);
        let Some(bucket) = index
            .checked_sub(1)
            .and_then(|index| buckets.get_mut(index))
        else {
            continue;
        };
        for (value, add) in bucket.values.iter_mut().zip(&slot.values) {
            *value += add;
        }
    }
    Bucketing {
        step_hours: step,
        buckets,
    }
}
