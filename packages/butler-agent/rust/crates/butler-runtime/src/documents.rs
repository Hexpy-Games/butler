//! Markdown document embeds, search text, exact edits and line diffs.
use pulldown_cmark::{CodeBlockKind, Event, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_BODY_BYTES: usize = 256 * 1024;
#[derive(Debug)]
pub struct Fence {
    pub line: usize,
    pub content: String,
}
#[derive(Default)]
pub struct Markdown {
    pub fences: Vec<Fence>,
    pub images: BTreeSet<String>,
    pub image_lines: BTreeMap<String, usize>,
    pub text: String,
}
/// CommonMark owns fence nesting, indentation, delimiter length and closing rules.
pub fn parse(body: &str) -> Markdown {
    let mut result = Markdown::default();
    let mut fence: Option<Fence> = None;
    let line_starts = std::iter::once(0)
        .chain(
            body.bytes()
                .enumerate()
                .filter(|(_, b)| *b == b'\n')
                .map(|(i, _)| i + 1),
        )
        .collect::<Vec<_>>();
    let line = |offset| line_starts.partition_point(|start| *start <= offset);
    for (event, range) in Parser::new(body).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info)))
                if info.as_ref() == "blocks" =>
            {
                fence = Some(Fence {
                    line: line(range.start),
                    content: String::new(),
                });
            }
            Event::End(TagEnd::CodeBlock) if fence.is_some() => {
                if let Some(block) = fence.take() {
                    if let Ok(spec) = serde_json::from_str::<Value>(&block.content) {
                        strings(&spec, None, &mut result.text, &mut result.images);
                    }
                    result.fences.push(block);
                }
            }
            Event::Start(Tag::Image { dest_url, .. }) if image_id(&dest_url) => {
                result
                    .image_lines
                    .insert(dest_url.to_string(), line(range.start));
                result.images.insert(dest_url.into_string());
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some(fence) = &mut fence {
                    fence.content.push_str(&text);
                } else {
                    result.text.push_str(&text);
                    result.text.push(' ');
                }
            }
            Event::SoftBreak | Event::HardBreak | Event::End(_) => result.text.push(' '),
            _ => {}
        }
    }
    result.text = result.text.split_whitespace().collect::<Vec<_>>().join(" ");
    result
}
pub fn image_id(text: &str) -> bool {
    text.strip_prefix("img_").is_some_and(|s| {
        (10..=12).contains(&s.len())
            && s.bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    })
}
fn strings(value: &Value, key: Option<&str>, text: &mut String, images: &mut BTreeSet<String>) {
    match value {
        Value::String(s) if image_id(s) => {
            if key == Some("img") {
                images.insert(s.clone());
            }
        }
        Value::String(s) if !matches!(key, Some("id" | "key")) && url::Url::parse(s).is_err() => {
            text.push_str(s);
            text.push(' ');
        }
        Value::Array(items) => {
            for item in items {
                strings(item, key, text, images);
            }
        }
        Value::Object(map) => {
            for (key, value) in map {
                strings(value, Some(key), text, images);
            }
        }
        _ => {}
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Replacement {
    pub anchor: String,
    pub replace: String,
}
#[derive(Debug, Serialize)]
pub struct EditError {
    pub code: &'static str,
    pub message: &'static str,
    pub op: usize,
}
fn edit_error(code: &'static str, message: &'static str, op: usize) -> EditError {
    EditError { code, message, op }
}
pub const REGION_CHANGED: &str =
    "The user changed this part since base_rev; read the document again and redo the edit.";
/// Resolve every range before applying any operation; byte ranges preserve UTF-8.
pub fn apply(base: &str, head: &str, ops: &[Replacement]) -> Result<String, EditError> {
    if !(1..=20).contains(&ops.len()) {
        return Err(edit_error("invalid_ops", "Provide 1–20 operations.", 0));
    }
    let mut ranges = Vec::new();
    for (i, op) in ops.iter().enumerate() {
        if !(1..=4000).contains(&op.anchor.chars().count()) || op.replace.chars().count() > 16000 {
            return Err(edit_error(
                "invalid_op",
                "Anchor or replacement exceeds its size limit.",
                i,
            ));
        }
        if !unique(base, &op.anchor) {
            return Err(edit_error(
                "invalid_anchor",
                "Anchor must occur exactly once in base_rev.",
                i,
            ));
        }
        if !unique(head, &op.anchor) {
            return Err(edit_error("region_changed", REGION_CHANGED, i));
        }
        if let Some(start) = head.find(&op.anchor) {
            ranges.push((start, start + op.anchor.len(), i));
        }
    }
    ranges.sort_unstable();
    for pair in ranges.windows(2) {
        if pair[0].1 > pair[1].0 {
            return Err(edit_error(
                "overlapping_ops",
                "Anchors must not overlap.",
                pair[1].2,
            ));
        }
    }
    let mut body = head.to_owned();
    for (start, end, i) in ranges.into_iter().rev() {
        body.replace_range(start..end, &ops[i].replace);
    }
    Ok(body)
}
fn unique(body: &str, anchor: &str) -> bool {
    let Some(first) = body.find(anchor) else {
        return false;
    };
    let next = first + body[first..].chars().next().map_or(0, char::len_utf8);
    !body[next..].contains(anchor)
}
pub fn diff(from: &str, to: &str) -> String {
    similar::TextDiff::configure()
        .algorithm(similar::Algorithm::Patience)
        .diff_lines(from, to)
        .unified_diff()
        .context_radius(3)
        .header("base", "head")
        .to_string()
}
pub fn changed(from: &str, to: &str) -> Vec<Value> {
    let diff = similar::TextDiff::configure()
        .algorithm(similar::Algorithm::Patience)
        .diff_lines(from, to);
    diff.ops().iter().filter(|op| op.tag() != similar::DiffTag::Equal).map(|op| {
        let range = op.new_range();
        serde_json::json!({"start_line":range.start + 1,"end_line":range.end.max(range.start + 1)})
    }).collect()
}
