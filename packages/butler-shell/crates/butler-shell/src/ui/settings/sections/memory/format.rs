//! The copy with arguments (`settings.memory.*`) and the number, size and time formats of
//! `memoryTypes`, `usePatterns`, `consolidationTime.ts` and `tokenWindowLabel`.
use butler_ds::ui::context::Lang;
use chrono::{DateTime, Local, Timelike as _, Utc};

use super::copy::Words;
use super::types::{Instruction, Pattern};
use crate::ui::i18n::Locale;

fn pick(lang: Lang, ko: String, en: String) -> String {
    match lang {
        Lang::Ko => ko,
        Lang::En => en,
    }
}

fn plural(n: u64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// `formatCount`: digits grouped by thousands.
pub(super) fn count(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// `formatFileSize`
pub(super) fn file_size(bytes: u64) -> String {
    let value = bytes as f64;
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", value / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", value / (1024.0 * 1024.0))
    } else {
        format!("{:.1} GB", value / (1024.0 * 1024.0 * 1024.0))
    }
}

fn parse(at: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(at)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

/// `relativeAge` of a timestamp, empty when it does not parse.
pub(super) fn relative_age(at: &str, lang: Lang) -> String {
    let Some(at) = parse(at) else {
        return String::new();
    };
    let seconds = (Utc::now() - at).num_seconds().max(0);
    let locale = match lang {
        Lang::Ko => Locale::Ko,
        Lang::En => Locale::En,
    };
    locale.strings().relative_age(seconds)
}

/// `memory.ago`
pub(super) fn ago(age: &str, lang: Lang) -> String {
    match (lang, age) {
        (Lang::Ko, "지금") => age.to_owned(),
        (Lang::Ko, _) => format!("{age} 전"),
        (Lang::En, "now") => "just now".to_owned(),
        (Lang::En, _) => format!("{age} ago"),
    }
}

/// `instructionScope`
pub(super) fn instruction_scope(item: &Instruction, copy: &Words) -> String {
    match item.scope.kind.as_str() {
        "session" => copy.this_chat.to_owned(),
        "all" => copy.all_chats.to_owned(),
        _ => item
            .scope
            .project_name
            .clone()
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| copy.project.to_owned()),
    }
}

/// `instructionDuration`
pub(super) fn instruction_duration(item: &Instruction, copy: &Words, lang: Lang) -> String {
    if item.duration.as_deref() == Some("this chat") {
        return copy.this_chat_only.to_owned();
    }
    let Some(expires) = item
        .expires_at
        .as_deref()
        .filter(|_| item.duration.as_deref() != Some("always"))
        .and_then(parse)
    else {
        return String::new();
    };
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "whole hours, at least one"
    )]
    let hours = ((expires - Utc::now()).num_milliseconds() as f64 / 3_600_000.0)
        .ceil()
        .max(1.0) as u64;
    if hours <= 24 {
        pick(
            lang,
            format!("{hours}시간 후 만료"),
            format!("Expires in {}", plural(hours, "hour", "hours")),
        )
    } else {
        let days = hours.div_ceil(24);
        pick(
            lang,
            format!("{days}일 후 만료"),
            format!("Expires in {days} days"),
        )
    }
}

/// `patternMeta`
pub(super) fn pattern_meta(item: &Pattern, lang: Lang) -> String {
    let first = parse(&item.evidence.first_at).unwrap_or_else(Utc::now);
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "whole days, at least one"
    )]
    let days = ((Utc::now() - first).num_milliseconds() as f64 / 86_400_000.0)
        .ceil()
        .max(1.0) as u64;
    let weeks = days / 7;
    let span = if days < 14 {
        pick(lang, format!("최근 {days}일"), format!("Last {days} days"))
    } else if weeks < 9 {
        pick(
            lang,
            format!("최근 {weeks}주"),
            format!("Last {weeks} weeks"),
        )
    } else {
        let months = (days / 30).max(1);
        pick(
            lang,
            format!("최근 {months}개월"),
            format!("Last {months} months"),
        )
    };
    let times = item.evidence.count;
    let times = pick(lang, format!("{times}번"), format!("{times} times"));
    format!("{span} · {times}")
}

/// `memory.removedChat`
pub(super) fn removed_chat(chats: u64, lang: Lang) -> String {
    pick(
        lang,
        format!("대화 기억 전체 (대화 {chats}개)"),
        format!("All chat memory ({})", plural(chats, "chat", "chats")),
    )
}

/// `memory.removedProfile`
pub(super) fn removed_profile(entries: u64, candidates: u64, lang: Lang) -> String {
    pick(
        lang,
        format!("프로필 (항목 {entries}개, 후보 {candidates}개)"),
        format!(
            "Your profile ({}, {candidates} pending)",
            plural(entries, "entry", "entries")
        ),
    )
}

/// `memory.removedProject`
pub(super) fn removed_project(chats: u64, instructions: u64, lang: Lang) -> String {
    pick(
        lang,
        format!("요약, 대화 기억 (대화 {chats}개), 이 프로젝트의 지침 {instructions}개"),
        format!(
            "Its summary, chat memory ({}) and {}",
            plural(chats, "chat", "chats"),
            plural(instructions, "instruction", "instructions")
        ),
    )
}

/// `memory.freeing`, `freed`, `freeStopped`, `freeCancelled`: the phase of a cleanup.
pub(super) fn free_text(phase: &str, bytes: u64, lang: Lang) -> String {
    let bytes = file_size(bytes);
    match (lang, phase) {
        (Lang::Ko, "freeing") => format!("공간 정리 중 · {bytes} 확보"),
        (Lang::Ko, "complete") => format!("공간 정리 완료 · {bytes} 확보"),
        (Lang::Ko, "failed") => format!("공간 정리 중단 · {bytes} 확보"),
        (Lang::Ko, _) => format!("공간 정리 취소 · {bytes} 확보"),
        (Lang::En, "freeing") => format!("Freeing up space… {bytes} so far"),
        (Lang::En, "complete") => format!("Freed up {bytes}"),
        (Lang::En, "failed") => format!("Couldn't finish. Freed up {bytes}."),
        (Lang::En, _) => format!("Cancelled. Freed up {bytes}."),
    }
}

/// `memory.lastRun` / `lastRunFailed`
pub(super) fn last_run(when: &str, failed: bool, lang: Lang) -> String {
    match (lang, failed) {
        (Lang::Ko, false) => format!("마지막 실행: {when}"),
        (Lang::Ko, true) => format!("마지막 실행 실패: {when}"),
        (Lang::En, false) => format!("Last run: {when}"),
        (Lang::En, true) => format!("Last run failed: {when}"),
    }
}

/// `formatConsolidationTime`: local calendar days, the app language's clock.
pub(super) fn consolidation_time(at: &str, copy: &Words, lang: Lang) -> String {
    let Some(at) = parse(at) else {
        return at.to_owned();
    };
    let date = at.with_timezone(&Local);
    let today = Local::now().date_naive();
    let day = if date.date_naive() == today {
        copy.today.to_owned()
    } else if today.pred_opt() == Some(date.date_naive()) {
        copy.yesterday.to_owned()
    } else {
        let pattern = match lang {
            Lang::Ko => "%y. %-m. %-d.",
            Lang::En => "%-m/%-d/%y",
        };
        date.format(pattern).to_string()
    };
    let (pm, hour) = date.hour12();
    let minute = date.minute();
    let clock = match lang {
        Lang::Ko => format!("{} {hour}:{minute:02}", if pm { "오후" } else { "오전" }),
        Lang::En => format!("{hour}:{minute:02} {}", if pm { "PM" } else { "AM" }),
    };
    format!("{day} {clock}")
}

/// `memoryModel.description`
pub(super) fn memory_model_description(size_mb: Option<u64>, lang: Lang) -> String {
    match (lang, size_mb) {
        (Lang::Ko, Some(mb)) => format!("대화를 더 잘 찾습니다 · 약 {mb} MB 내려받기"),
        (Lang::Ko, None) => "대화를 더 잘 찾습니다".to_owned(),
        (Lang::En, Some(mb)) => format!("Finds chats better · About {mb} MB download"),
        (Lang::En, None) => "Finds chats better".to_owned(),
    }
}

/// `tokenWindowLabel` (its suffix is English in every language, as in React).
pub(super) fn token_window_label(tokens: Option<f64>, lang: Lang) -> String {
    match tokens.filter(|tokens| tokens.is_finite()) {
        None => pick(
            lang,
            "컨텍스트 미확인".to_owned(),
            "context unknown".to_owned(),
        ),
        Some(tokens) if tokens >= 1_000_000.0 => {
            let millions = format!("{:.2}", tokens / 1_000_000.0);
            format!(
                "{}M API context",
                millions.trim_end_matches('0').trim_end_matches('.')
            )
        }
        Some(tokens) => format!("{}k API context", (tokens / 1000.0).round()),
    }
}
