//! `commandPaletteLabels.ts`, `logTraceCommand.ts` (the result list) and the settings entries
//! of `CommandPalette.tsx`.
use butler_ds::ui::context::Lang;

use crate::ui::i18n::palette::{
    Every, SETTINGS_SECTIONS, Words, clock, daily_at, every, weekday, weekly_at, words,
};
use crate::ui::source::wire::{
    CalendarSchedule, CalendarScheduleKind, CommandPaletteResult, CommandPaletteResultKind,
};

/// `LOG_TRACE_COMMAND_ID`
pub(super) const LOG_TRACE_COMMAND_ID: &str = "open-logs";

/// `kindLabels[kind]`
fn kind_label(kind: &CommandPaletteResultKind, words: &Words) -> &'static str {
    match kind {
        CommandPaletteResultKind::Chat => words.kind_chat,
        CommandPaletteResultKind::Project => words.kind_project,
        CommandPaletteResultKind::ProjectSession => words.kind_project_session,
        CommandPaletteResultKind::Group => words.kind_group,
        CommandPaletteResultKind::Automation => words.kind_automation,
        CommandPaletteResultKind::Settings => words.kind_settings,
        CommandPaletteResultKind::Unknown => "",
    }
}

/// `SERVER_KIND_SUBTITLES`: generic subtitles the app server uses when a result has no location.
fn server_kind_subtitle(kind: &CommandPaletteResultKind) -> Option<&'static str> {
    match kind {
        CommandPaletteResultKind::Chat => Some("Chat"),
        CommandPaletteResultKind::ProjectSession => Some("Project chat"),
        CommandPaletteResultKind::Project => Some("Project"),
        CommandPaletteResultKind::Group => Some("스페이스"),
        CommandPaletteResultKind::Settings => Some("Settings"),
        CommandPaletteResultKind::Automation | CommandPaletteResultKind::Unknown => None,
    }
}

/// `commandResultSubtitle`
pub(super) fn result_subtitle(result: &CommandPaletteResult, lang: Lang) -> String {
    let words = words(lang);
    if result.kind == CommandPaletteResultKind::Automation
        && (result.schedule.is_some() || result.interval_seconds.is_some_and(|s| s != 0))
    {
        return schedule_frequency(result, lang);
    }
    let subtitle = result
        .subtitle
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();
    if subtitle.is_empty() || Some(subtitle) == server_kind_subtitle(&result.kind) {
        return kind_label(&result.kind, words).to_owned();
    }
    subtitle.to_owned()
}

/// `commandResultTitle` (`sessionDisplayTitle` for chats: the general channel is localized).
pub(super) fn result_title(result: &CommandPaletteResult, lang: Lang) -> String {
    let chat = matches!(
        result.kind,
        CommandPaletteResultKind::Chat | CommandPaletteResultKind::ProjectSession
    );
    if chat && result.id == "general" {
        return words(lang).general.to_owned();
    }
    result.title.clone()
}

/// `scheduleFrequency`
fn schedule_frequency(result: &CommandPaletteResult, lang: Lang) -> String {
    if let Some(rule) = &result.schedule {
        return rule_frequency(rule, lang);
    }
    if result.schedule_type.as_deref() == Some("once") {
        return words(lang).once.to_owned();
    }
    let seconds = result.interval_seconds.filter(|s| *s != 0).unwrap_or(1800);
    if seconds % 3600 == 0 {
        every(lang, Every::Hours, seconds / 3600)
    } else if seconds % 60 == 0 {
        every(lang, Every::Minutes, seconds / 60)
    } else {
        every(lang, Every::Seconds, seconds)
    }
}

/// The calendar rule of `scheduleFrequency`.
fn rule_frequency(rule: &CalendarSchedule, lang: Lang) -> String {
    let mut parts = rule
        .time
        .split(':')
        .map(|part| part.parse::<i64>().unwrap_or(0));
    let time = clock(lang, parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    if rule.kind == CalendarScheduleKind::Daily {
        return daily_at(lang, false, &time);
    }
    if rule.weekdays == [1, 2, 3, 4, 5] {
        return daily_at(lang, true, &time);
    }
    let days: Vec<&str> = rule
        .weekdays
        .iter()
        .map(|day| weekday(lang, *day))
        .collect();
    weekly_at(lang, &days.join(", "), &time)
}

/// `highlightMatch` needle and the settings search: trimmed and lowercased.
fn normalize(value: &str) -> String {
    value.trim().to_lowercase()
}

/// `logTraceCommandResults`: developer mode, 로그 열기, matched in the app language and in
/// English.
fn log_trace_results(query: &str, developer_mode: bool, lang: Lang) -> Vec<CommandPaletteResult> {
    if !developer_mode {
        return Vec::new();
    }
    let copy = words(lang);
    let needle = normalize(query);
    let logs = SETTINGS_SECTIONS
        .iter()
        .find(|(id, _, _)| *id == "logs")
        .map_or("", |(_, ko, en)| if lang == Lang::Ko { ko } else { en });
    let names = [copy.open_logs, words(Lang::En).open_logs, logs];
    if !needle.is_empty() && !names.iter().any(|name| normalize(name).contains(&needle)) {
        return Vec::new();
    }
    vec![local_result(
        LOG_TRACE_COMMAND_ID,
        copy.open_logs,
        copy.open_logs_hint,
        "settings:logs",
    )]
}

/// `settingsResults`: the settings pages whose name matches, in the app language or English
/// (`matchesSettingsSection`).
fn settings_results(query: &str, developer_mode: bool, lang: Lang) -> Vec<CommandPaletteResult> {
    let needle = normalize(query);
    SETTINGS_SECTIONS
        .iter()
        .filter(|(id, _, _)| developer_mode || *id != "logs")
        .map(|(id, ko, en)| (*id, if lang == Lang::Ko { *ko } else { *en }, *en))
        .filter(|(_, label, english)| {
            normalize(label).contains(&needle) || normalize(english).contains(&needle)
        })
        .map(|(id, label, _)| {
            local_result(
                &format!("settings:{id}"),
                label,
                words(lang).kind_settings,
                &format!("settings:{id}"),
            )
        })
        .collect()
}

fn local_result(id: &str, title: &str, subtitle: &str, route: &str) -> CommandPaletteResult {
    CommandPaletteResult {
        schedule: None,
        schedule_type: None,
        interval_seconds: None,
        id: id.to_owned(),
        kind: CommandPaletteResultKind::Settings,
        title: title.to_owned(),
        subtitle: Some(subtitle.to_owned()),
        route: route.to_owned(),
    }
}

/// The local entries (log trace, settings) that lead the list.
pub(super) fn local_results(
    query: &str,
    developer_mode: bool,
    lang: Lang,
) -> Vec<CommandPaletteResult> {
    let mut results = log_trace_results(query, developer_mode, lang);
    results.extend(settings_results(query, developer_mode, lang));
    results
}

/// The row id: `${result.kind}-${result.id}`.
pub(super) fn kind_key(kind: &CommandPaletteResultKind) -> &'static str {
    match kind {
        CommandPaletteResultKind::Chat => "chat",
        CommandPaletteResultKind::Project => "project",
        CommandPaletteResultKind::ProjectSession => "project_session",
        CommandPaletteResultKind::Group => "group",
        CommandPaletteResultKind::Automation => "automation",
        CommandPaletteResultKind::Settings => "settings",
        CommandPaletteResultKind::Unknown => "unknown",
    }
}
