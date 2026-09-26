use crate::public_text::fixed_regex::fixed_regex_ci;
use std::{collections::HashMap, sync::OnceLock};

use regex::Regex;
use serde_json::Value;

use super::super::types::ProjectCapsuleSourceSnapshot;

const PROMOTIONS_PER_CATEGORY: usize = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum PromotionCategory {
    Conventions,
    Decisions,
    Feedback,
    Risks,
}

impl PromotionCategory {
    fn as_str(self) -> &'static str {
        match self {
            Self::Conventions => "conventions",
            Self::Decisions => "decisions",
            Self::Feedback => "feedback",
            Self::Risks => "risks",
        }
    }
}

#[derive(Clone)]
struct Candidate {
    category: PromotionCategory,
    text: String,
    normalized: String,
    provenance: String,
}

#[derive(Clone)]
pub(super) struct Promotion {
    pub(super) text: String,
    pub(super) sources: usize,
    pub(super) provenance: Vec<String>,
}

pub(super) fn collect_promotions(
    snapshot: &ProjectCapsuleSourceSnapshot,
) -> HashMap<PromotionCategory, Vec<Promotion>> {
    let mut sources = Vec::new();
    for task in &snapshot.tasks {
        push_source(&mut sources, &task.request, format!("task:{}", task.id));
        push_source(&mut sources, &task.result, format!("task:{}", task.id));
    }
    for item in &snapshot.evidence {
        push_source(
            &mut sources,
            &item.text,
            format!("memory-evidence:{}", item.path),
        );
    }
    for item in &snapshot.graph {
        push_source(&mut sources, &item.text, item.provenance.clone());
    }

    let mut groups: Vec<Vec<Candidate>> = Vec::new();
    let mut indexes = HashMap::new();
    for (text, provenance) in sources {
        for candidate in promotion_candidates(&text, &provenance) {
            let key = format!("{}\0{}", candidate.category.as_str(), candidate.normalized);
            let index = *indexes.entry(key).or_insert_with(|| {
                groups.push(Vec::new());
                groups.len() - 1
            });
            groups[index].push(candidate);
        }
    }

    let mut result: HashMap<PromotionCategory, Vec<Promotion>> = HashMap::new();
    for candidates in groups {
        let mut provenance = Vec::new();
        for candidate in &candidates {
            if !provenance.contains(&candidate.provenance) {
                provenance.push(candidate.provenance.clone());
            }
        }
        if provenance.len() < 2 {
            continue;
        }
        let first = &candidates[0];
        result.entry(first.category).or_default().push(Promotion {
            text: first.text.clone(),
            sources: provenance.len(),
            provenance: provenance.into_iter().take(5).collect(),
        });
    }
    for items in result.values_mut() {
        items.sort_by(|left, right| {
            right
                .sources
                .cmp(&left.sources)
                .then_with(|| left.text.cmp(&right.text))
        });
        items.truncate(PROMOTIONS_PER_CATEGORY);
    }
    result
}

fn push_source(sources: &mut Vec<(String, String)>, text: &str, provenance: String) {
    if !crate::public_text::trim_js_whitespace(text).is_empty() {
        sources.push((text.to_owned(), provenance));
    }
}

fn promotion_candidates(text: &str, provenance: &str) -> Vec<Candidate> {
    let mut result = Vec::new();
    for fragment in statement_fragments(text) {
        let Some(category) = category_for(&fragment) else {
            continue;
        };
        let normalized = normalized_statement(&fragment);
        if utf16_len(&normalized) < 12 {
            continue;
        }
        result.push(Candidate {
            category,
            text: compact(&fragment, 180),
            normalized,
            provenance: provenance.to_owned(),
        });
    }
    result
}

fn statement_fragments(text: &str) -> Vec<String> {
    let mut statements = Vec::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        for fragment in split_sentences(line) {
            let fragment = strip_markdown_prefix(&fragment);
            let fragment = strip_provenance(&fragment);
            let units = utf16_len(&fragment);
            if (18..=240).contains(&units)
                && !fragment.to_ascii_lowercase().starts_with("provenance:")
                && !fragment.to_ascii_lowercase().starts_with("source_counts:")
            {
                statements.push(fragment);
            }
        }
    }
    statements
}

fn split_sentences(line: &str) -> Vec<String> {
    let chars = line.char_indices().collect::<Vec<_>>();
    let mut parts = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index < chars.len() {
        let (position, character) = chars[index];
        let previous_is_punctuation =
            index > 0 && matches!(chars[index - 1].1, '.' | '!' | '?' | '。');
        if previous_is_punctuation && crate::public_text::is_js_whitespace(character) {
            parts.push(line[start..position].to_owned());
            while index < chars.len() && crate::public_text::is_js_whitespace(chars[index].1) {
                index += 1;
            }
            start = chars.get(index).map_or(line.len(), |(next, _)| *next);
        } else {
            index += 1;
        }
    }
    parts.push(line[start..].to_owned());
    parts
}

fn strip_markdown_prefix(value: &str) -> String {
    let mut text = crate::public_text::trim_js_whitespace(value);
    if let Some(first) = text.chars().next()
        && matches!(first, '-' | '*')
    {
        let rest = &text[first.len_utf8()..];
        if rest
            .chars()
            .next()
            .is_some_and(crate::public_text::is_js_whitespace)
        {
            text = rest.trim_start_matches(crate::public_text::is_js_whitespace);
        }
    }
    if text.starts_with('#') {
        let hashes = text
            .chars()
            .take_while(|character| *character == '#')
            .count();
        let rest = &text[hashes..];
        text = rest.trim_start_matches(crate::public_text::is_js_whitespace);
    }
    crate::public_text::trim_js_whitespace(text).to_owned()
}

fn strip_provenance(value: &str) -> String {
    static TRAILER: OnceLock<Regex> = OnceLock::new();
    let regex = TRAILER.get_or_init(|| fixed_regex_ci(r"\s*\((?:provenance|source):[^)]*\)\s*$"));
    crate::public_text::trim_js_whitespace(&regex.replace(value, "")).to_owned()
}

fn category_for(statement: &str) -> Option<PromotionCategory> {
    static LABEL: OnceLock<Regex> = OnceLock::new();
    let regex = LABEL.get_or_init(|| {
        fixed_regex_ci(r"^\s*(?:\[(convention|conventions|decision|decisions|feedback|risk|risks)\]|(convention|conventions|decision|decisions|feedback|risk|risks)\s*[:：-])")
    });
    let captures = regex.captures(statement)?;
    let label = captures
        .get(1)
        .or_else(|| captures.get(2))?
        .as_str()
        .to_ascii_lowercase();
    match label.as_str() {
        "convention" | "conventions" => Some(PromotionCategory::Conventions),
        "decision" | "decisions" => Some(PromotionCategory::Decisions),
        "feedback" => Some(PromotionCategory::Feedback),
        "risk" | "risks" => Some(PromotionCategory::Risks),
        _ => None,
    }
}

fn normalized_statement(statement: &str) -> String {
    let mut normalized = String::new();
    let mut needs_space = false;
    for character in statement.to_lowercase().chars() {
        let allowed = character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || ('가'..='힣').contains(&character);
        if allowed {
            if needs_space && !normalized.is_empty() {
                normalized.push(' ');
            }
            needs_space = false;
            normalized.push(character);
        } else {
            needs_space = true;
        }
    }
    normalized
}

pub(super) fn compact(value: &str, limit: usize) -> String {
    let normalized = value
        .split(crate::public_text::is_js_whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if utf16_len(&normalized) <= limit {
        return normalized;
    }
    format!("{}...", prefix_utf16(&normalized, limit.saturating_sub(3)))
}

fn prefix_utf16(value: &str, limit: usize) -> String {
    let mut output = String::new();
    let mut units = 0;
    for character in value.chars() {
        let next = character.len_utf16();
        if units + next > limit {
            break;
        }
        output.push(character);
        units += next;
    }
    output
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

pub(super) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::Array(values) => values.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

pub(super) fn extend_promotions(
    lines: &mut Vec<String>,
    category: PromotionCategory,
    promotions: &HashMap<PromotionCategory, Vec<Promotion>>,
) {
    if let Some(items) = promotions.get(&category)
        && !items.is_empty()
    {
        render_promotions(lines, category, items);
    } else {
        let label = match category {
            PromotionCategory::Conventions => {
                "No explicit project conventions have been promoted yet."
            }
            PromotionCategory::Decisions => "No durable project decisions have been promoted yet.",
            PromotionCategory::Feedback => "",
            PromotionCategory::Risks => "No explicit project risks have been promoted yet.",
        };
        if !label.is_empty() {
            lines.push(format!("- {label}"));
        }
    }
}

pub(super) fn render_promotions(
    lines: &mut Vec<String>,
    category: PromotionCategory,
    items: &[Promotion],
) {
    for item in items {
        lines.push(format!(
            "- {} (provenance: promoted:{}; sources={}; evidence={})",
            item.text,
            category.as_str(),
            item.sources,
            item.provenance.join(", "),
        ));
    }
}
