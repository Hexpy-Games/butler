//! What the document dialog reads from a project document: `app/projectDocumentReader.ts`
//! (`projectDocumentReaderView`) and the parts of `app/projectDocuments.ts` it uses (the badge,
//! the status label and `projectDocumentMarkdownView`).
use butler_ds::ui::context::Lang;
use chrono::{DateTime, Datelike as _, Local, Timelike as _};

use super::super::copy::Words;
use super::super::selection::document_type;
use crate::ui::source::wire::{ProjectDashboardDocument, ProjectDashboardDocumentType};

/// `ProjectDocumentFrontmatterEntry`
pub(super) struct Entry {
    pub(super) key: String,
    pub(super) label: String,
    pub(super) value: String,
}

/// One fact of the reader's header block.
pub(super) struct Fact {
    pub(super) id: &'static str,
    pub(super) label: String,
    pub(super) value: String,
}

/// `projectDocumentReaderView`
pub(super) struct Reader {
    pub(super) facts: Vec<Fact>,
    pub(super) details: Vec<Entry>,
    pub(super) body: String,
}

/// Frontmatter keys the entries list leaves out (`HIDDEN_FRONTMATTER_KEYS`).
const HIDDEN: [&str; 2] = ["schema", "title"];
/// What the details list already shows elsewhere.
const SHOWN: [&str; 6] = [
    "id",
    "kind",
    "status",
    "updatedAt",
    "updated_at",
    "revision",
];

/// `projectDocumentBadgeLabel`
pub(super) fn badge(document: &ProjectDashboardDocument, copy: &Words) -> &'static str {
    use ProjectDashboardDocumentType as Type;
    match document_type(document) {
        Type::Artifact => copy.results,
        Type::Task => copy.task,
        Type::Plan => copy.plan,
        Type::Roadmap => copy.roadmap,
        Type::Spec => copy.spec,
        Type::Report | Type::Message => copy.report,
        Type::Reference => copy.tab_history,
        Type::Work | Type::Unknown => copy.document,
    }
}

/// `projectDocumentStatusLabel`
fn status_label(document: &ProjectDashboardDocument, status: &str, copy: &Words) -> String {
    let task = document_type(document) == ProjectDashboardDocumentType::Task;
    let key = match status {
        "completed" if task => "done",
        "in_review" if task => "review",
        other => other,
    };
    copy.status(key)
        .or_else(|| copy.status(status))
        .map_or_else(|| status.to_owned(), str::to_owned)
}

/// `new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" })`; `None` for a
/// date that does not read.
fn date_time(value: &str, lang: Lang) -> Option<String> {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let at = DateTime::parse_from_rfc3339(value)
        .ok()?
        .with_timezone(&Local);
    let (hour, minute) = (at.hour(), at.minute());
    let clock = format!(
        "{}:{minute:02}",
        if hour % 12 == 0 { 12 } else { hour % 12 }
    );
    Some(match lang {
        Lang::Ko => format!(
            "{}. {}. {}. {} {clock}",
            at.year(),
            at.month(),
            at.day(),
            if hour < 12 { "오전" } else { "오후" }
        ),
        Lang::En => format!(
            "{} {}, {}, {clock} {}",
            MONTHS[at.month0() as usize % 12],
            at.day(),
            at.year(),
            if hour < 12 { "AM" } else { "PM" }
        ),
    })
}

/// `projectDocumentReaderView`
pub(super) fn reader_view(document: &ProjectDashboardDocument, copy: &Words, lang: Lang) -> Reader {
    let label = |key: &str| copy.label(key).unwrap_or(key).to_owned();
    let (body, frontmatter) = markdown_view(&document.markdown, copy);
    let mut facts = vec![Fact {
        id: "kind",
        label: label("kind"),
        value: badge(document, copy).to_owned(),
    }];
    if let Some(status) = document.status.as_deref().filter(|s| !s.is_empty()) {
        facts.push(Fact {
            id: "status",
            label: label("status"),
            value: status_label(document, status, copy),
        });
    }
    if let Some(value) = date_time(&document.updated_at, lang) {
        facts.push(Fact {
            id: "updatedAt",
            label: label("updatedAt"),
            value,
        });
    }
    if !document.safe_path_label.is_empty() {
        facts.push(Fact {
            id: "source",
            label: label("source"),
            value: document.safe_path_label.clone(),
        });
    }
    let mut details = vec![Entry {
        key: "id".to_owned(),
        label: label("id"),
        value: document.id.clone(),
    }];
    if let Some(revision) = document.revision.as_deref().filter(|r| !r.is_empty()) {
        details.push(Entry {
            key: "revision".to_owned(),
            label: label("revision"),
            value: revision.to_owned(),
        });
    }
    details.extend(
        frontmatter
            .into_iter()
            .filter(|entry| !SHOWN.contains(&entry.key.as_str())),
    );
    Reader {
        facts,
        details,
        body,
    }
}

/// `projectDocumentMarkdownView`: the body without its frontmatter, and the frontmatter entries.
pub(super) fn markdown_view(markdown: &str, copy: &Words) -> (String, Vec<Entry>) {
    let Some(rest) = markdown
        .strip_prefix("---\r\n")
        .or_else(|| markdown.strip_prefix("---\n"))
    else {
        return (markdown.to_owned(), Vec::new());
    };
    let Some(end) = rest.find("\n---") else {
        return (markdown.to_owned(), Vec::new());
    };
    let block = rest[..end].strip_suffix('\r').unwrap_or(&rest[..end]);
    let after = &rest[end + "\n---".len()..];
    let after = after
        .strip_prefix("\r\n")
        .or_else(|| after.strip_prefix('\n'))
        .unwrap_or(after);
    (after.trim_start().to_owned(), frontmatter(block, copy))
}

/// `parseProjectDocumentFrontmatter`
fn frontmatter(text: &str, copy: &Words) -> Vec<Entry> {
    text.split('\n')
        .filter_map(|line| {
            let (key, value) = line.trim_end_matches('\r').split_once(':')?;
            let valid = !key.is_empty()
                && key
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
            let value = clean(value.trim_start());
            (valid && !value.is_empty() && !HIDDEN.contains(&key)).then(|| Entry {
                key: key.to_owned(),
                label: copy
                    .label(key)
                    .map_or_else(|| title_case(key), str::to_owned),
                value,
            })
        })
        .collect()
}

/// `cleanFrontmatterValue`
fn clean(value: &str) -> String {
    let value = value.trim();
    let value = value.strip_prefix(['"', '\'']).unwrap_or(value);
    let value = value.strip_suffix(['"', '\'']).unwrap_or(value);
    let value = value
        .strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(value);
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == ',' {
            out.push_str(", ");
            while chars.next_if(|next| next.is_whitespace()).is_some() {}
        } else {
            out.push(ch);
        }
    }
    out
}

/// `titleCaseKey`
fn title_case(key: &str) -> String {
    let mut spaced = String::new();
    let mut previous: Option<char> = None;
    for ch in key.chars() {
        if ch == '-' || ch == '_' {
            if previous != Some(' ') {
                spaced.push(' ');
            }
            previous = Some(' ');
            continue;
        }
        if ch.is_ascii_uppercase() && previous.is_some_and(|p| p.is_ascii_lowercase()) {
            spaced.push(' ');
        }
        spaced.push(ch);
        previous = Some(ch);
    }
    let mut word = false;
    spaced
        .chars()
        .map(|ch| {
            let starts = ch.is_alphanumeric() && !word;
            word = ch.is_alphanumeric();
            if starts { ch.to_ascii_uppercase() } else { ch }
        })
        .collect()
}
