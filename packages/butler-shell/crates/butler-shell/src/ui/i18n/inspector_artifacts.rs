//! The copy of the inspector's artifacts and schedules panels, and `scheduleFrequency`. Each
//! field names its `packages/butler-i18n` key.
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

use crate::ui::source::wire::{AutomationTargetSummary, CalendarScheduleKind};

pub(crate) struct InspectorArtifacts {
    /// artifacts.title, artifacts.empty
    pub(crate) artifacts_title: &'static str,
    pub(crate) artifacts_empty: &'static str,
    /// automations.title, automations.once
    pub(crate) automations_title: &'static str,
    /// sessionInfo.artifacts
    pub(crate) results_title: &'static str,
    once: &'static str,
}

const KO: InspectorArtifacts = InspectorArtifacts {
    artifacts_title: "아티팩트",
    artifacts_empty: "아직 아티팩트가 없습니다",
    automations_title: "예약 작업",
    results_title: "결과물",
    once: "한 번",
};

const EN: InspectorArtifacts = InspectorArtifacts {
    artifacts_title: "Artifacts",
    artifacts_empty: "No artifacts yet",
    automations_title: "Schedules",
    results_title: "Results",
    once: "Once",
};

const KO_DAYS: [&str; 7] = [
    "일요일",
    "월요일",
    "화요일",
    "수요일",
    "목요일",
    "금요일",
    "토요일",
];
const EN_DAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

impl InspectorArtifacts {
    pub(crate) fn of(lang: Lang) -> &'static Self {
        match lang {
            Lang::Ko => &KO,
            Lang::En => &EN,
        }
    }

    pub(crate) fn get(cx: &App) -> &'static Self {
        Self::of(Ds::get(cx).lang())
    }

    /// `scheduleFrequency`: how often a schedule runs.
    pub(crate) fn frequency(lang: Lang, target: &AutomationTargetSummary) -> String {
        if let Some(rule) = &target.schedule {
            let time = clock(lang, &rule.time);
            if rule.kind == CalendarScheduleKind::Daily {
                return match lang {
                    Lang::Ko => format!("매일 {time}"),
                    Lang::En => format!("Every day at {time}"),
                };
            }
            if rule.weekdays == [1, 2, 3, 4, 5] {
                return match lang {
                    Lang::Ko => format!("평일 {time}"),
                    Lang::En => format!("Every weekday at {time}"),
                };
            }
            let days = if lang == Lang::Ko { KO_DAYS } else { EN_DAYS };
            let names: Vec<&str> = rule
                .weekdays
                .iter()
                .map(|day| days[usize::try_from(day.rem_euclid(7)).unwrap_or_default()])
                .collect();
            let names = names.join(", ");
            return match lang {
                Lang::Ko => format!("매주 {names} {time}"),
                Lang::En => format!("Every {names} at {time}"),
            };
        }
        if target.schedule_type.as_deref() == Some("once") {
            return Self::of(lang).once.to_owned();
        }
        let seconds = target.interval_seconds.unwrap_or(1800);
        match (lang, seconds) {
            (Lang::Ko, s) if s % 3600 == 0 => format!("{}시간마다", s / 3600),
            (Lang::En, 3600) => "Every hour".to_owned(),
            (Lang::En, s) if s % 3600 == 0 => format!("Every {} hours", s / 3600),
            (Lang::Ko, s) if s % 60 == 0 => format!("{}분마다", s / 60),
            (Lang::En, s) if s % 60 == 0 => format!("Every {} minutes", s / 60),
            (Lang::Ko, s) => format!("{s}초마다"),
            (Lang::En, s) => format!("Every {s} seconds"),
        }
    }
}

/// `Intl.DateTimeFormat` with hour numeric and minute 2-digit for an `HH:MM` string.
fn clock(lang: Lang, time: &str) -> String {
    let mut parts = time.split(':').map(|part| part.parse::<u32>().unwrap_or(0));
    let (hour, minute) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    let twelve = if hour % 12 == 0 { 12 } else { hour % 12 };
    match (lang, hour < 12) {
        (Lang::Ko, true) => format!("오전 {twelve}:{minute:02}"),
        (Lang::Ko, false) => format!("오후 {twelve}:{minute:02}"),
        (Lang::En, true) => format!("{twelve}:{minute:02} AM"),
        (Lang::En, false) => format!("{twelve}:{minute:02} PM"),
    }
}
