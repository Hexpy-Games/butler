//! Renders parsed Markdown with MarkdownContent's metrics
//! (blocks/MarkdownContent/MarkdownContent.module.css).
use std::ops::Range;

use gpui::{AnyElement, Div, FontWeight, HighlightStyle, Hsla, StyledText, div, prelude::*, px};

use super::markdown::{Block, inline, parse};
use crate::theme::Theme;
use crate::widgets::{icon, text};

fn heading_metrics(level: u8) -> (f32, f32, f32) {
    // (font size, line height, margin-top)
    match level {
        1 => (24., 32., 32.),
        2 => (18., 26., 24.),
        3 => (15., 20., 20.),
        _ => (14., 20., 16.),
    }
}

pub(crate) fn render(src: &str, theme: &Theme) -> AnyElement {
    let blocks = parse(src);
    let mut col = div()
        .flex()
        .flex_col()
        .w_full()
        .min_w_0()
        .text_size(px(14.))
        .line_height(px(22.))
        .text_color(theme.text);
    let mut prev_heading: Option<bool> = None;
    for block in &blocks {
        let is_heading = matches!(block, Block::Heading(..));
        let gap = match (prev_heading, block) {
            (None, _) => 0.,
            (_, Block::Heading(l, _)) => heading_metrics(*l).2,
            (Some(true), _) => 12.,
            (Some(false), _) => 16.,
        };
        col = col.child(div().mt(px(gap)).child(render_block(block, theme)));
        prev_heading = Some(is_heading);
    }
    col.into_any_element()
}

fn render_block(block: &Block, theme: &Theme) -> AnyElement {
    match block {
        Block::Heading(level, s) => {
            let (size, lh, _) = heading_metrics(*level);
            div()
                .text_size(px(size))
                .line_height(px(lh))
                .font_weight(FontWeight::MEDIUM)
                .child(inline(s, theme))
                .into_any_element()
        }
        Block::Para(s) => div().child(inline(s, theme)).into_any_element(),
        Block::Quote(s) => div()
            .border_l(px(2.))
            .border_color(theme.line_strong)
            .pl(px(16.))
            .text_color(theme.text2)
            .child(inline(s, theme))
            .into_any_element(),
        Block::List { ordered, items } => {
            let mut list = div().flex().flex_col().gap(px(8.));
            for (n, item) in items.iter().enumerate() {
                let marker = if *ordered {
                    format!("{}.", n + 1)
                } else {
                    "•".to_string()
                };
                list = list.child(
                    div()
                        .flex()
                        .child(
                            div()
                                .w(px(24.))
                                .flex_none()
                                .flex()
                                .justify_end()
                                .pr(px(8.))
                                .child(marker),
                        )
                        .child(div().flex_1().min_w_0().child(inline(item, theme))),
                );
            }
            list.into_any_element()
        }
        Block::Code { lang, body } => code_block(lang, body, theme).into_any_element(),
        Block::Table(rows) => table(rows, theme).into_any_element(),
    }
}

fn code_block(lang: &str, body: &str, theme: &Theme) -> Div {
    let label = if lang.is_empty() {
        "text".to_string()
    } else {
        lang.to_string()
    };
    let mut pre = div()
        .p(px(16.))
        .flex()
        .flex_col()
        .font_family(theme.code_font.clone())
        .text_size(px(13.))
        .line_height(px(20.));
    for line in body.lines() {
        pre = pre.child(
            div()
                .whitespace_nowrap()
                .min_h(px(20.))
                .child(highlight_line(line, theme)),
        );
    }
    div()
        .w_full()
        .overflow_hidden()
        .rounded(px(10.))
        .border_1()
        .border_color(theme.line)
        .bg(theme.surface_raised)
        .child(
            div()
                .h(px(30.))
                .flex()
                .items_center()
                .justify_between()
                .pl(px(16.))
                .pr(px(4.))
                .border_b_1()
                .border_color(theme.line)
                .child(text(label, (13., 18.), FontWeight::NORMAL, theme.text3))
                .child(
                    div()
                        .size(px(26.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon("copy", 14., theme.text3)),
                ),
        )
        .child(pre)
}

const KEYWORDS: &[&str] = &[
    "fn", "let", "mut", "use", "pub", "impl", "struct", "async", "await", "match", "if", "else",
    "return", "for", "in", "mod",
];

fn highlight_line(line: &str, theme: &Theme) -> StyledText {
    let mut hl: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
    let color = |c: Hsla| HighlightStyle {
        color: Some(c),
        ..Default::default()
    };
    let comment = line.find("//");
    let code_end = comment.unwrap_or(line.len());
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < code_end {
        let c = bytes[i];
        if c == b'"' {
            let end = line[i + 1..code_end]
                .find('"')
                .map(|e| i + e + 2)
                .unwrap_or(code_end);
            hl.push((i..end, color(theme.syntax.string)));
            i = end;
        } else if c.is_ascii_alphabetic() || c == b'_' {
            let end = line[i..code_end]
                .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_'))
                .map(|e| i + e)
                .unwrap_or(code_end);
            let word = &line[i..end];
            if KEYWORDS.contains(&word) {
                hl.push((i..end, color(theme.syntax.keyword)));
            } else if line[end..].starts_with('(') {
                hl.push((i..end, color(theme.syntax.title)));
            }
            i = end;
        } else if c.is_ascii_digit() {
            let end = line[i..code_end]
                .find(|ch: char| !ch.is_ascii_digit())
                .map(|e| i + e)
                .unwrap_or(code_end);
            hl.push((i..end, color(theme.syntax.number)));
            i = end;
        } else {
            i += line[i..].chars().next().map(char::len_utf8).unwrap_or(1);
        }
    }
    if let Some(start) = comment {
        hl.push((start..line.len(), color(theme.syntax.comment)));
    }
    StyledText::new(line.to_string()).with_highlights(hl)
}

fn table(rows: &[Vec<String>], theme: &Theme) -> Div {
    let mut t = div()
        .flex()
        .flex_col()
        .w_full()
        .border_t_1()
        .border_l_1()
        .border_color(theme.line);
    for (r, row) in rows.iter().enumerate() {
        let mut tr = div().flex().w_full();
        for cell in row {
            let mut td = div()
                .flex_1()
                .min_w_0()
                .px(px(12.))
                .py(px(8.))
                .border_r_1()
                .border_b_1()
                .border_color(theme.line)
                .child(cell.clone());
            if r == 0 {
                td = td.bg(theme.selection).font_weight(FontWeight::MEDIUM);
            }
            tr = tr.child(td);
        }
        t = t.child(tr);
    }
    t
}
