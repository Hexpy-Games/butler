//! A small Markdown subset (headings, paragraphs, lists, code, quotes, tables; inline bold and
//! code) parsed into blocks; [`super::markdown_view`] renders them.
use std::ops::Range;

use gpui::{FontWeight, HighlightStyle, SharedString, StyledText};

use crate::ui::theme::Theme;

pub(crate) enum Block {
    Heading(u8, String),
    Para(String),
    List { ordered: bool, items: Vec<String> },
    Code { lang: String, body: String },
    Quote(String),
    Table(Vec<Vec<String>>),
}

pub(crate) fn parse(src: &str) -> Vec<Block> {
    let lines: Vec<&str> = src.lines().collect();
    let mut blocks = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim_end();
        let t = line.trim_start();
        if t.is_empty() {
            i += 1;
        } else if let Some(lang) = t.strip_prefix("```") {
            let mut body = Vec::new();
            i += 1;
            while i < lines.len() && !lines[i].trim_start().starts_with("```") {
                body.push(lines[i]);
                i += 1;
            }
            i += 1;
            blocks.push(Block::Code {
                lang: lang.trim().into(),
                body: body.join("\n"),
            });
        } else if t.starts_with('#') {
            let hashes = t.chars().take_while(|c| *c == '#').count().min(6);
            let level = u8::try_from(hashes).unwrap_or(6);
            blocks.push(Block::Heading(level, t[hashes..].trim().into()));
            i += 1;
        } else if t.starts_with('|') {
            let mut rows = Vec::new();
            while i < lines.len() && lines[i].trim_start().starts_with('|') {
                let row = lines[i].trim().trim_matches('|');
                if !row.chars().all(|c| matches!(c, '-' | '|' | ':' | ' ')) {
                    rows.push(row.split('|').map(|c| c.trim().to_string()).collect());
                }
                i += 1;
            }
            blocks.push(Block::Table(rows));
        } else if let Some(q) = t.strip_prefix('>') {
            blocks.push(Block::Quote(q.trim().into()));
            i += 1;
        } else if list_item(t).is_some() {
            let ordered = t.chars().next().is_some_and(|c| c.is_ascii_digit());
            let mut items = Vec::new();
            while i < lines.len() {
                match list_item(lines[i].trim_start()) {
                    Some(item) => items.push(item.to_string()),
                    None => break,
                }
                i += 1;
            }
            blocks.push(Block::List { ordered, items });
        } else {
            let mut para = vec![t];
            i += 1;
            while i < lines.len() {
                let n = lines[i].trim();
                if n.is_empty()
                    || n.starts_with('#')
                    || n.starts_with("```")
                    || n.starts_with('|')
                    || list_item(n).is_some()
                {
                    break;
                }
                para.push(n);
                i += 1;
            }
            blocks.push(Block::Para(para.join(" ")));
        }
    }
    blocks
}

fn list_item(t: &str) -> Option<&str> {
    if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
        return Some(rest);
    }
    let digits = t.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 {
        t[digits..].strip_prefix(". ")
    } else {
        None
    }
}

/// `**bold**` and `` `code` `` spans: plain text plus highlight ranges.
pub(crate) fn inline(src: &str, theme: &Theme) -> StyledText {
    let mut out = String::with_capacity(src.len());
    let mut highlights: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
    let mut fonts: Vec<(Range<usize>, SharedString)> = Vec::new();
    let mut rest = src;
    loop {
        let bold = rest.find("**");
        let code = rest.find('`');
        let next = match (bold, code) {
            (Some(b), Some(c)) => Some((b.min(c), b <= c)),
            (Some(b), None) => Some((b, true)),
            (None, Some(c)) => Some((c, false)),
            (None, None) => None,
        };
        let Some((at, is_bold)) = next else { break };
        let marker = if is_bold { "**" } else { "`" };
        let after = &rest[at + marker.len()..];
        let Some(end) = after.find(marker) else { break };
        out.push_str(&rest[..at]);
        let start = out.len();
        out.push_str(&after[..end]);
        let range = start..out.len();
        if is_bold {
            highlights.push((
                range,
                HighlightStyle {
                    font_weight: Some(FontWeight::BOLD),
                    ..Default::default()
                },
            ));
        } else {
            highlights.push((
                range.clone(),
                HighlightStyle {
                    background_color: Some(theme.selection),
                    ..Default::default()
                },
            ));
            fonts.push((range, theme.code_font.clone()));
        }
        rest = &after[end + marker.len()..];
    }
    out.push_str(rest);
    StyledText::new(out)
        .with_highlights(highlights)
        .with_font_family_overrides(fonts)
}
