//! `operationStructuredOutputPresentation.ts`: public content fields of a structured result;
//! receipts, identities and raw JSON are never shown.
use butler_ds::ui::context::Lang;
use serde_json::{Map, Value};

use super::present::{Presentation, Section, flag, number_text, record, string, truthy};
use crate::ui::chat::activity::tools::copy::{self, text};

type Fields = Map<String, Value>;

const TEXT_KEYS: [&str; 11] = [
    "analysis",
    "markdown",
    "body",
    "content",
    "text",
    "summary",
    "description",
    "message",
    "snippet",
    "bounded_content",
    "csv_preview",
];
const COLLECTION_KEYS: [&str; 18] = [
    "descriptions",
    "tools",
    "capabilities",
    "results",
    "matches",
    "documents",
    "messages",
    "summaries",
    "items",
    "entries",
    "sessions",
    "skills",
    "servers",
    "resources",
    "public_web_evidence_items",
    "evidence_items",
    "content",
    "contents",
];
const ENVELOPE_KEYS: [&str; 7] = [
    "output", "result", "data", "work", "text", "stdout", "stderr",
];

/// presentStructuredOperation
pub(super) fn present(value: &Fields, lang: Lang) -> Option<Presentation> {
    if flag(value, "pending", true) || flag(value, "authority_pending", true) {
        return Some(Presentation::Summary(
            text(lang, "st.notExecuted").to_owned(),
        ));
    }
    let error = record(value.get("error"));
    let message = error.and_then(|error| error.get("message"));
    if flag(value, "ok", false)
        && (truthy(message) || matches!(value.get("error"), Some(Value::String(_))))
    {
        let reason = match string(message) {
            "" => string(value.get("error")),
            message => message,
        };
        return Some(Presentation::Sections {
            summary: text(lang, "st.toolFailed").to_owned(),
            sections: vec![Section {
                title: text(lang, "st.failureReason").to_owned(),
                content: Some(reason.to_owned()),
                message: None,
            }],
        });
    }
    let sections = public_sections(value, lang);
    if sections.is_empty() {
        return None;
    }
    let summary = if flag(value, "ok", false) {
        text(lang, "st.toolFailed").to_owned()
    } else {
        copy::count_summary(lang, "results", &sections.len().to_string(), false)
    };
    Some(Presentation::Sections { summary, sections })
}

fn title_of(value: &Fields, lang: Lang) -> String {
    ["title", "label", "display_name", "name"]
        .iter()
        .map(|key| string(value.get(*key)))
        .find(|title| !title.is_empty())
        .unwrap_or_else(|| text(lang, "st.result"))
        .to_owned()
}

/// The text fields, deduplicated, then the dimensions and the input schema fields.
fn parts_of(value: &Fields, lang: Lang) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    for key in TEXT_KEYS {
        if let Some(Value::String(part)) = value.get(key)
            && !part.is_empty()
            && !parts.contains(part)
        {
            parts.push(part.clone());
        }
    }
    if let (Some(rows), Some(columns)) = (
        value.get("row_count").and_then(Value::as_f64),
        value.get("columns").and_then(Value::as_array),
    ) {
        let label = match value.get("artifact_label") {
            Some(Value::String(label)) => format!(" · {label}"),
            _ => String::new(),
        };
        let size = copy::dimensions(lang, &number_text(rows), columns.len());
        parts.insert(0, format!("{size}{label}"));
    }
    let schema = record(value.get("schema")).or_else(|| record(value.get("input_schema")));
    if let Some(properties) = record(schema.and_then(|schema| schema.get("properties"))) {
        let fields = properties
            .iter()
            .map(|(key, entry)| {
                let field = record(Some(entry));
                [
                    key.as_str(),
                    string(field.and_then(|f| f.get("type"))),
                    string(field.and_then(|f| f.get("description"))),
                ]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" · ")
            })
            .collect::<Vec<_>>()
            .join("\n");
        parts.push(format!("{}\n{fields}", text(lang, "st.inputFields")));
    }
    parts
}

fn public_sections(value: &Fields, lang: Lang) -> Vec<Section> {
    let title = title_of(value, lang);
    let parts = parts_of(value, lang);
    let mut own: Vec<Section> = Vec::new();
    if !parts.is_empty() {
        own.push(Section {
            title: title.clone(),
            content: Some(parts.join("\n\n")),
            message: None,
        });
    }
    for key in COLLECTION_KEYS {
        let Some(entries) = value.get(key).and_then(Value::as_array) else {
            continue;
        };
        for entry in entries {
            match entry {
                Value::String(content) => own.push(Section {
                    title: title.clone(),
                    content: Some(content.clone()),
                    message: None,
                }),
                Value::Object(object) => own.extend(public_sections(object, lang)),
                _ => {}
            }
        }
    }
    for key in ENVELOPE_KEYS {
        if let Some(nested) = record(value.get(key)) {
            own.extend(public_sections(nested, lang));
        }
    }
    if own.is_empty() && title != text(lang, "st.result") {
        own.push(Section {
            title,
            content: None,
            message: None,
        });
    }
    own
}
