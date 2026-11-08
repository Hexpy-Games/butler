//! Pure TimePicker logic (timeModel.ts): the locale's facts, segment typing and stepping. React
//! reads them from `Intl`; Rust has no Intl, so the two UI languages carry them as constants.
use crate::ui::context::Lang;

/// 12-hour with a day period, or 24-hour.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum HourCycle {
    #[default]
    H12,
    H23,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Segment {
    Period,
    Hour,
    Minute,
}

impl Segment {
    pub(super) fn key(self) -> &'static str {
        match self {
            Self::Period => "period",
            Self::Hour => "hour",
            Self::Minute => "minute",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Parts {
    pub(super) hours: i32,
    pub(super) minutes: i32,
}

/// What the language fixes: segment order, the day-period words and the segment names.
#[derive(Clone, Copy)]
pub(super) struct Layout {
    pub(super) order: &'static [Segment],
    pub(super) periods: [&'static str; 2],
    lang: Lang,
}

/// The hour and minute are joined by this (`segmentLayout`'s separator).
pub(super) const SEPARATOR: &str = ":";

impl Layout {
    /// ko-KR writes the period first ("오전 09:00"), en-US last ("09:00 AM"); 24-hour has none.
    pub(super) fn of(lang: Lang, cycle: HourCycle) -> Self {
        use Segment::{Hour, Minute, Period};
        let order: &'static [Segment] = match (lang, cycle) {
            (_, HourCycle::H23) => &[Hour, Minute],
            (Lang::Ko, HourCycle::H12) => &[Period, Hour, Minute],
            (Lang::En, HourCycle::H12) => &[Hour, Minute, Period],
        };
        let periods = match lang {
            Lang::Ko => ["오전", "오후"],
            Lang::En => ["AM", "PM"],
        };
        Self {
            order,
            periods,
            lang,
        }
    }

    /// `segmentNames`: the accessible and column names.
    pub(super) fn name(&self, segment: Segment) -> &'static str {
        match (self.lang, segment) {
            (Lang::Ko, Segment::Hour) => "시",
            (Lang::Ko, Segment::Minute) => "분",
            (Lang::Ko, Segment::Period) => "오전/오후",
            (Lang::En, Segment::Hour) => "Hour",
            (Lang::En, Segment::Minute) => "Minute",
            (Lang::En, Segment::Period) => "AM/PM",
        }
    }

    pub(super) fn index(&self, segment: Segment) -> Option<usize> {
        self.order.iter().position(|s| *s == segment)
    }
}

pub(super) fn pad(n: i32) -> String {
    format!("{n:02}")
}

pub(super) fn parse(value: &str) -> Parts {
    let mut numbers = value.split(':').map(|part| part.trim().parse::<i32>().ok());
    let mut next = |max: i32| numbers.next().flatten().map_or(0, |n| n.clamp(0, max));
    Parts {
        hours: next(23),
        minutes: next(59),
    }
}

pub(super) fn format(parts: Parts) -> String {
    format!("{}:{}", pad(parts.hours), pad(parts.minutes))
}

pub(super) fn is_pm(parts: Parts) -> bool {
    parts.hours >= 12
}

pub(super) fn hour12(hours: i32) -> i32 {
    match hours % 12 {
        0 => 12,
        h => h,
    }
}

pub(super) fn with_hour12(parts: Parts, h12: i32, pm: bool) -> Parts {
    Parts {
        hours: (h12 % 12) + if pm { 12 } else { 0 },
        ..parts
    }
}

/// The text a segment shows.
pub(super) fn display(segment: Segment, cycle: HourCycle, parts: Parts, layout: &Layout) -> String {
    match segment {
        Segment::Period => layout.periods[usize::from(is_pm(parts))].to_owned(),
        Segment::Hour if cycle == HourCycle::H12 => pad(hour12(parts.hours)),
        Segment::Hour => pad(parts.hours),
        Segment::Minute => pad(parts.minutes),
    }
}

/// ArrowUp/ArrowDown on one segment; each segment wraps on its own (the hour keeps its day
/// period, as native time fields do).
pub(super) fn step(segment: Segment, cycle: HourCycle, parts: Parts, delta: i32) -> Parts {
    match segment {
        Segment::Period => Parts {
            hours: (parts.hours + 12) % 24,
            ..parts
        },
        Segment::Minute => Parts {
            minutes: (parts.minutes + delta).rem_euclid(60),
            ..parts
        },
        Segment::Hour if cycle == HourCycle::H23 => Parts {
            hours: (parts.hours + delta).rem_euclid(24),
            ..parts
        },
        Segment::Hour => {
            let next = (hour12(parts.hours) - 1 + delta).rem_euclid(12) + 1;
            with_hour12(parts, next, is_pm(parts))
        }
    }
}

/// Home and End: the segment's minimum or maximum.
pub(super) fn home_end(segment: Segment, cycle: HourCycle, parts: Parts, home: bool) -> Parts {
    let pm = is_pm(parts);
    match segment {
        Segment::Minute => Parts {
            minutes: if home { 0 } else { 59 },
            ..parts
        },
        Segment::Period => Parts {
            hours: (parts.hours % 12) + if home { 0 } else { 12 },
            ..parts
        },
        Segment::Hour if cycle == HourCycle::H12 => {
            with_hour12(parts, if home { 1 } else { 12 }, pm)
        }
        Segment::Hour => Parts {
            hours: if home { 0 } else { 23 },
            ..parts
        },
    }
}

/// A typed letter on the period: its first letter, or A and P. `Some(true)` is the second word.
pub(super) fn period_letter(periods: &[&str; 2], key: &str) -> Option<bool> {
    if key.len() != 1 || !key.is_ascii() || !key.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let key = key.to_lowercase();
    let starts = |word: &str| word.to_lowercase().starts_with(&key);
    let pm = starts(periods[1]) || key == "p";
    let am = starts(periods[0]) || key == "a";
    (pm != am).then_some(pm)
}

pub(super) fn set_period(parts: Parts, pm: bool) -> Parts {
    Parts {
        hours: (parts.hours % 12) + if pm { 12 } else { 0 },
        ..parts
    }
}

pub(super) struct Typed {
    pub(super) parts: Parts,
    pub(super) pending: String,
    pub(super) advance: bool,
}

/// One typed digit (the openstatus/shadcn segment rule): a second digit completes the value, an
/// impossible first digit completes at once.
pub(super) fn type_digit(
    segment: Segment,
    cycle: HourCycle,
    parts: Parts,
    pending: &str,
    digit: i32,
) -> Typed {
    let done = |parts: Parts, advance: bool| Typed {
        parts,
        pending: String::new(),
        advance,
    };
    let more = |parts: Parts, pending: String| Typed {
        parts,
        pending,
        advance: false,
    };
    match (segment, cycle) {
        (Segment::Period, _) => done(parts, false),
        (Segment::Minute, _) => {
            if !pending.is_empty() {
                let minutes = pending.parse::<i32>().unwrap_or(0) * 10 + digit;
                return done(Parts { minutes, ..parts }, true);
            }
            let next = Parts {
                minutes: digit,
                ..parts
            };
            if digit > 5 {
                done(next, true)
            } else {
                more(next, digit.to_string())
            }
        }
        (Segment::Hour, HourCycle::H23) => {
            if !pending.is_empty() {
                let value = pending.parse::<i32>().unwrap_or(0) * 10 + digit;
                return if value <= 23 {
                    done(
                        Parts {
                            hours: value,
                            ..parts
                        },
                        true,
                    )
                } else {
                    done(
                        Parts {
                            hours: digit,
                            ..parts
                        },
                        digit > 2,
                    )
                };
            }
            let next = Parts {
                hours: digit,
                ..parts
            };
            if digit > 2 {
                done(next, true)
            } else {
                more(next, digit.to_string())
            }
        }
        (Segment::Hour, HourCycle::H12) => hour12_digit(parts, pending, digit),
    }
}

fn hour12_digit(parts: Parts, pending: &str, digit: i32) -> Typed {
    let pm = is_pm(parts);
    let at = |h12: i32| with_hour12(parts, h12, pm);
    let done = |parts: Parts| Typed {
        parts,
        pending: String::new(),
        advance: true,
    };
    let more = |parts: Parts, pending: &str| Typed {
        parts,
        pending: pending.to_owned(),
        advance: false,
    };
    match (pending, digit) {
        ("0", 0) => more(parts, "0"),
        ("0", d) => done(at(d)),
        ("1", d) if d <= 2 => done(at(10 + d)),
        (_, 0) => more(parts, "0"),
        (_, 1) => more(at(1), "1"),
        (_, d) => done(at(d)),
    }
}

/// One wheel row: the value it sets and its label.
pub(super) struct Choice {
    pub(super) value: i32,
    pub(super) label: String,
}

/// `columnOptions`: the minute column keeps a typed off-step minute in order.
pub(super) fn choices(
    segment: Segment,
    cycle: HourCycle,
    layout: &Layout,
    minute_step: i32,
    minutes: i32,
) -> Vec<Choice> {
    let numbered = |values: Vec<i32>| {
        values
            .into_iter()
            .map(|value| Choice {
                value,
                label: pad(value),
            })
            .collect()
    };
    match segment {
        Segment::Period => layout
            .periods
            .iter()
            .zip(0..)
            .map(|(label, value)| Choice {
                value,
                label: (*label).to_owned(),
            })
            .collect(),
        Segment::Hour if cycle == HourCycle::H12 => numbered((1..=12).collect()),
        Segment::Hour => numbered((0..24).collect()),
        Segment::Minute => {
            let step = minute_step.max(1);
            let mut values: Vec<i32> = (0..(60 + step - 1) / step).map(|i| i * step).collect();
            if !values.contains(&minutes) {
                values.push(minutes);
            }
            values.sort_unstable();
            numbered(values)
        }
    }
}

pub(super) fn selected(segment: Segment, cycle: HourCycle, parts: Parts) -> i32 {
    match segment {
        Segment::Period => i32::from(is_pm(parts)),
        Segment::Minute => parts.minutes,
        Segment::Hour if cycle == HourCycle::H12 => hour12(parts.hours),
        Segment::Hour => parts.hours,
    }
}

/// What a wheel pick sets.
pub(super) fn apply(segment: Segment, cycle: HourCycle, parts: Parts, value: i32) -> Parts {
    match segment {
        Segment::Period => with_hour12(parts, hour12(parts.hours), value == 1),
        Segment::Minute => Parts {
            minutes: value,
            ..parts
        },
        Segment::Hour if cycle == HourCycle::H12 => with_hour12(parts, value, is_pm(parts)),
        Segment::Hour => Parts {
            hours: value,
            ..parts
        },
    }
}
