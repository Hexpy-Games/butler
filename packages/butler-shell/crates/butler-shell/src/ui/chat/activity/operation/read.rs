//! `operationReadOutputPresentation.ts`: the file, search and document listing outputs.
use butler_ds::ui::context::Lang;
use serde_json::{Map, Value};

use super::present::{Presentation, Section, flag, number_text, record, string, truthy};
use crate::ui::chat::activity::tools::copy::{self, text};

type Fields = Map<String, Value>;

/// presentReadOperation
pub(super) fn present(tool: Option<&str>, value: &Fields, lang: Lang) -> Option<Presentation> {
    let truncated = truthy(value.get("truncated"));
    if tool == Some("read_file")
        && let Some(files) = value.get("files").and_then(Value::as_array)
    {
        let files = records(files);
        let read = files
            .iter()
            .filter(|file| flag(file, "ok", true) && !truthy(file.get("skipped")))
            .count();
        let count = format!("{read}/{}", files.len());
        return Some(Presentation::Sections {
            summary: copy::count_summary(lang, "filesRead", &count, truncated),
            sections: files
                .iter()
                .map(|file| read_file_section(file, lang))
                .collect(),
        });
    }
    if tool == Some("list_files")
        && let Some(files) = value.get("files").and_then(Value::as_array)
    {
        let files = records(files);
        return Some(Presentation::Sections {
            summary: copy::count_summary(lang, "files", &files.len().to_string(), truncated),
            sections: files
                .iter()
                .map(|file| Section {
                    title: display_path(file.get("path"), lang),
                    message: file
                        .get("bytes")
                        .and_then(Value::as_u64)
                        .map(|bytes| copy::bytes(lang, bytes)),
                    content: None,
                })
                .collect(),
        });
    }
    if tool == Some("grep_files")
        && let Some(matches) = value.get("matches").and_then(Value::as_array)
    {
        let matches = records(matches);
        return Some(Presentation::Sections {
            summary: copy::count_summary(lang, "matches", &matches.len().to_string(), truncated),
            sections: matches
                .iter()
                .map(|found| match_section(found, lang))
                .collect(),
        });
    }
    ledger(tool, value, lang)
}

fn match_section(found: &Fields, lang: Lang) -> Section {
    let line = found
        .get("line")
        .and_then(Value::as_f64)
        .map(|line| format!(" · {}", copy::lines(lang, &number_text(line))))
        .unwrap_or_default();
    Section {
        title: format!("{}{line}", display_path(found.get("path"), lang)),
        content: Some(string(found.get("text")).to_owned()),
        message: None,
    }
}

fn ledger(tool: Option<&str>, value: &Fields, lang: Lang) -> Option<Presentation> {
    let data = record(value.get("data"));
    if !flag(value, "ok", true) {
        return None;
    }
    if tool == Some("project_ledger_list")
        && let Some(results) = data
            .and_then(|data| data.get("results"))
            .and_then(Value::as_array)
    {
        let documents = records(results);
        return Some(Presentation::Sections {
            summary: copy::count_summary(lang, "documents", &documents.len().to_string(), false),
            sections: documents
                .iter()
                .map(|doc| document_section(doc, lang))
                .collect(),
        });
    }
    if tool == Some("project_ledger_show")
        && let Some(data) = data
    {
        return Some(Presentation::Sections {
            summary: text(lang, "st.documentRead").to_owned(),
            sections: vec![document_section(data, lang)],
        });
    }
    None
}

fn records(items: &[Value]) -> Vec<&Fields> {
    items.iter().filter_map(Value::as_object).collect()
}

fn read_file_section(file: &Fields, lang: Lang) -> Section {
    let range = match (
        file.get("start_line").and_then(Value::as_f64),
        file.get("end_line").and_then(Value::as_f64),
    ) {
        (Some(start), Some(end)) if end >= start => {
            let span = if start == end {
                number_text(start)
            } else {
                format!("{}–{}", number_text(start), number_text(end))
            };
            format!(" · {}", copy::lines(lang, &span))
        }
        _ => String::new(),
    };
    let title = format!("{}{range}", display_path(file.get("path"), lang));
    let message = |message: String| Section {
        title: title.clone(),
        content: None,
        message: Some(message),
    };
    if truthy(file.get("pending")) {
        return message(text(lang, "st.pendingRead").to_owned());
    }
    if truthy(file.get("skipped")) {
        return message(text(lang, "st.skippedRead").to_owned());
    }
    if !flag(file, "ok", true) {
        return message(read_failure_message(file.get("error"), lang));
    }
    let content = string(file.get("content")).to_owned();
    let note = if truthy(file.get("truncated")) {
        Some(text(lang, "st.truncatedRead").to_owned())
    } else if content.is_empty() {
        Some(text(lang, "st.emptyText").to_owned())
    } else {
        None
    };
    Section {
        title,
        content: Some(content),
        message: note,
    }
}

fn read_failure_message(error: Option<&Value>, lang: Lang) -> String {
    let code = match error {
        Some(Value::String(code)) => code.as_str(),
        other => string(record(other).and_then(|fields| fields.get("code"))),
    };
    let key = match code {
        "not_found" => "st.fileNotFound",
        "not_a_file" => "st.notFile",
        "sensitive_path_blocked" => "st.sensitiveFile",
        "protected_path" => "st.protectedFile",
        "binary_file_not_supported" => "st.binaryFile",
        "invalid_utf8" => "st.invalidUtf8",
        "io_error" => "st.ioError",
        "max_total_bytes" => "st.maxBytes",
        "max_bytes_too_small_for_utf8" => "st.maxBytesUtf8",
        _ => "st.readFailed",
    };
    text(lang, key).to_owned()
}

fn document_section(document: &Fields, lang: Lang) -> Section {
    let kind = match string(document.get("kind")) {
        "spec" => Some("st.spec"),
        "plan" => Some("st.planning"),
        "work" => Some("st.work"),
        "task" => Some("st.task"),
        "review" => Some("st.reviewNoun"),
        "report" => Some("st.report"),
        "result" => Some("st.result"),
        _ => None,
    };
    let status = match string(document.get("status")) {
        "draft" => Some("st.draft"),
        "active" | "in_progress" => Some("st.inProgress"),
        "done" => Some("st.completed"),
        "blocked" => Some("st.blocked"),
        "specified" => Some("st.specified"),
        "accepted" => Some("st.accepted"),
        "planned" => Some("st.planned"),
        "cancelled" => Some("st.cancelled"),
        _ => None,
    };
    let message = [kind, status]
        .into_iter()
        .flatten()
        .map(|key| text(lang, key))
        .collect::<Vec<_>>()
        .join(" · ");
    let title = string(document.get("title"));
    Section {
        title: if title.is_empty() {
            text(lang, "st.document").to_owned()
        } else {
            title.to_owned()
        },
        message: (!message.is_empty()).then_some(message),
        content: document
            .get("body")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

/// displayPath
fn display_path(value: Option<&Value>, lang: Lang) -> String {
    let path = string(value).replace('\\', "/");
    let file = text(lang, "st.file");
    if path.is_empty() {
        return file.to_owned();
    }
    let bytes = path.as_bytes();
    let drive = bytes.first().is_some_and(u8::is_ascii_alphabetic)
        && bytes.get(1) == Some(&b':')
        && bytes.get(2) == Some(&b'/');
    if path.starts_with('/') || drive {
        return path
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or(file)
            .to_owned();
    }
    path
}
