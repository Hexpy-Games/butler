//! The catalog text this unit shows (packages/butler-i18n `guided`, `progress`,
//! `interfaceStatus`, `interfaceDetails`, `interfaceFeedback`, `conversation.work`), in both
//! locales. `copy.tsv` holds `key<TAB>English<TAB>Korean` rows of catalog strings; the
//! catalog's formatter functions are the functions below.
use std::collections::HashMap;
use std::sync::OnceLock;

use butler_ds::ui::context::Lang;

const CATALOG: &str = include_str!("copy.tsv");

type Row = (&'static str, &'static str);

fn table() -> &'static HashMap<&'static str, Row> {
    static TABLE: OnceLock<HashMap<&'static str, Row>> = OnceLock::new();
    TABLE.get_or_init(|| {
        CATALOG
            .lines()
            .filter_map(|line| {
                let mut cells = line.split('\t');
                Some((cells.next()?, (cells.next()?, cells.next()?)))
            })
            .collect()
    })
}

fn pick(lang: Lang, row: Row) -> &'static str {
    match lang {
        Lang::En => row.0,
        Lang::Ko => row.1,
    }
}

/// The catalog string for `key`, or `None` when the catalog has none (`catalog[key]` undefined).
pub(in crate::ui::chat::activity) fn find(lang: Lang, key: &str) -> Option<&'static str> {
    table().get(key).map(|row| pick(lang, *row))
}

/// The catalog string for `key`; every key the callers name is in `copy.tsv`.
pub(in crate::ui::chat::activity) fn text(lang: Lang, key: &str) -> &'static str {
    find(lang, key).unwrap_or_default()
}

/// The first `ws.` worker status key whose text, in either locale, is `value`.
pub(in crate::ui::chat::activity) fn worker_status_key(value: &str) -> Option<&'static str> {
    [Lang::En, Lang::Ko].into_iter().find_map(|lang| {
        CATALOG.lines().find_map(|line| {
            let mut cells = line.split('\t');
            let key = cells.next()?.strip_prefix("ws.")?;
            let row = (cells.next()?, cells.next()?);
            (pick(lang, row) == value).then_some(key)
        })
    })
}

fn ko(lang: Lang) -> bool {
    lang == Lang::Ko
}

/// interfaceStatus.countSummary: `kind` is filesRead, files, matches, documents or results.
pub(in crate::ui::chat::activity) fn count_summary(
    lang: Lang,
    kind: &str,
    count: &str,
    truncated: bool,
) -> String {
    let (en, ko_head, unit) = match kind {
        "filesRead" => ("Files read", "파일 읽기", "개"),
        "files" => ("Files", "파일 목록", "개"),
        "matches" => ("Matches", "검색 결과", "건"),
        "documents" => ("Documents", "문서 목록", "개"),
        _ => ("Results", "조회 결과", "개"),
    };
    let head = if ko(lang) {
        format!("{ko_head} · {count}{unit}")
    } else {
        format!("{en} · {count}")
    };
    match (truncated, ko(lang)) {
        (false, _) => head,
        (true, true) => format!("{head} · 일부 결과"),
        (true, false) => format!("{head} · Partial results"),
    }
}

/// interfaceStatus.bytes: the count with thousands separators.
pub(in crate::ui::chat::activity) fn bytes(lang: Lang, count: u64) -> String {
    let digits = count.to_string();
    let mut grouped = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    if ko(lang) {
        format!("{grouped}바이트")
    } else {
        format!("{grouped} bytes")
    }
}

/// interfaceStatus.lines
pub(in crate::ui::chat::activity) fn lines(lang: Lang, range: &str) -> String {
    if ko(lang) {
        format!("{range}줄")
    } else {
        format!("line {range}")
    }
}

/// interfaceStatus.exitCode
pub(in crate::ui::chat::activity) fn exit_code(lang: Lang, code: &str) -> String {
    if ko(lang) {
        format!("종료 코드 {code}")
    } else {
        format!("Exit code {code}")
    }
}

/// interfaceStatus.commandStreams
pub(in crate::ui::chat::activity) fn command_streams(
    lang: Lang,
    stdout: &str,
    stderr: &str,
) -> String {
    if ko(lang) {
        format!("출력\n{stdout}\n\n오류 출력\n{stderr}")
    } else {
        format!("Output\n{stdout}\n\nError output\n{stderr}")
    }
}

/// interfaceStatus.dimensions
pub(in crate::ui::chat::activity) fn dimensions(lang: Lang, rows: &str, columns: usize) -> String {
    if ko(lang) {
        format!("{rows}행 · {columns}열")
    } else {
        format!("{rows} rows · {columns} columns")
    }
}

/// conversation.work.detailRow
pub(in crate::ui::chat::activity) fn detail_row(label: &str, value: &str) -> String {
    format!("{label}: {value}")
}

/// conversation.work.webSearchDetail
pub(in crate::ui::chat::activity) fn web_search_detail(lang: Lang, value: &str) -> String {
    if ko(lang) {
        format!("웹 검색: {value}")
    } else {
        format!("Web search: {value}")
    }
}

/// conversation.work.webSearchSummary
pub(in crate::ui::chat::activity) fn web_search_summary(lang: Lang, count: usize) -> String {
    if ko(lang) {
        format!("웹 검색 {count}회")
    } else {
        format!("Web search {count} queries")
    }
}

/// conversation.work.toolStepsSummary
pub(in crate::ui::chat::activity) fn tool_steps_summary(
    lang: Lang,
    name: &str,
    count: usize,
) -> String {
    if ko(lang) {
        format!("{name} {count}단계")
    } else {
        format!("{name} {count} steps")
    }
}

/// guided.conceptionSummary
pub(in crate::ui::chat::activity) fn conception_summary(lang: Lang, value: &str) -> String {
    match (ko(lang), value.is_empty()) {
        (true, true) => "요청의 목표와 범위를 확인했습니다.".into(),
        (true, false) => format!("요청의 목표와 범위를 확인했습니다: {value}"),
        (false, true) => "Confirmed the request goal and scope.".into(),
        (false, false) => format!("Confirmed the request goal and scope: {value}"),
    }
}

/// guided.workInProgress
pub(in crate::ui::chat::activity) fn work_in_progress(lang: Lang, value: &str) -> String {
    if ko(lang) {
        format!("{value} 작업을 진행하고 있습니다.")
    } else {
        format!("Working on {value}.")
    }
}

/// guided.toolsSummary
pub(in crate::ui::chat::activity) fn tools_summary(lang: Lang, value: &str) -> String {
    match (ko(lang), value.is_empty()) {
        (true, true) => "필요한 도구로 작업을 진행하고 있습니다.".into(),
        (true, false) => format!("{value} 도구로 필요한 정보를 확인하고 있습니다."),
        (false, true) => "Working with the required tools.".into(),
        (false, false) => format!("Checking the required information with {value}."),
    }
}
