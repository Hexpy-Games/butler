use std::collections::HashMap;
use std::ops::Range;

use butler_ds::ui::blocks::markdown_content::{is_external, label};
use butler_ds::ui::markdown::{Block, Inline, Item, Table, parse, plain};
use pulldown_cmark::{Alignment, Event, Options, Parser, Tag, TagEnd};

use super::html::Out;

/// The Globe2 icon markup.
const GLOBE_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" color="currentColor" class=""><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"></circle><path d="M8 12C8 18 12 22 12 22C12 22 16 18 16 12C16 6 12 2 12 2C12 2 8 6 8 12Z" stroke="currentColor" stroke-linejoin="round" stroke-width="1.5"></path><path d="M21 15H3" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"></path><path d="M21 9H3" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"></path></svg>"#;

const OPTIONS: Options = Options::ENABLE_TABLES
    .union(Options::ENABLE_STRIKETHROUGH)
    .union(Options::ENABLE_TASKLISTS);

pub(super) fn nodes(text: &str) -> Vec<Range<usize>> {
    let mut nodes = Vec::new();
    let (mut depth, mut start, mut end) = (0, 0, 0);
    for (event, range) in Parser::new_ext(text, OPTIONS).into_offset_iter() {
        match event {
            Event::Start(_) => {
                if depth == 0 {
                    start = text[..range.start].rfind('\n').map_or(0, |i| i + 1);
                }
                depth += 1;
                continue;
            }
            Event::End(_) => {
                depth -= 1;
                if depth != 0 {
                    continue;
                }
            }
            Event::Rule if depth == 0 => {
                start = text[..range.start].rfind('\n').map_or(0, |i| i + 1);
            }
            _ => continue,
        }
        if !text[end..start].trim().is_empty() {
            nodes.push(end..end);
        }
        end = range.end;
        nodes.push(start..end);
    }
    if !text[end..].trim().is_empty() {
        nodes.push(end..end);
    }
    nodes
}

pub(super) fn content(out: &mut Out, slice: &str, images: &HashMap<String, String>) {
    out.raw("<div class=\"MarkdownContent__markdown\" data-selectable=\"\">");
    out.0.push_str(&inner(slice, images));
    out.close("div");
}

pub(super) fn inner(src: &str, images: &HashMap<String, String>) -> String {
    let mut lists = Vec::new();
    let mut tables = Vec::new();
    let mut tasks = Vec::new();
    let mut tags = Vec::new();
    let mut open_lists = Vec::new();
    for event in Parser::new_ext(src, OPTIONS) {
        match event {
            Event::Start(tag) => {
                let end = tag.to_end();
                match tag {
                    Tag::List(_) => {
                        open_lists.push(lists.len());
                        lists.push((false, false));
                    }
                    Tag::Item => tasks.push(None),
                    Tag::Paragraph
                        if matches!(tags.as_slice(), [.., TagEnd::List(_), TagEnd::Item]) =>
                    {
                        if let Some(&list) = open_lists.last() {
                            lists[list].0 = true;
                        }
                    }
                    Tag::Table(alignments) => tables.push(alignments),
                    _ => {}
                }
                tags.push(end);
            }
            Event::End(end) => {
                tags.pop();
                if matches!(end, TagEnd::List(_)) {
                    open_lists.pop();
                }
            }
            Event::TaskListMarker(checked) => {
                if let Some(&list) = open_lists.last()
                    && let Some(task) = tasks.last_mut()
                {
                    lists[list].1 = true;
                    *task = Some(checked);
                }
            }
            _ => {}
        }
    }
    let mut render = Render {
        out: Out::default(),
        images,
        lists: lists.into_iter(),
        tables: tables.into_iter(),
        tasks: tasks.into_iter(),
    };
    render.blocks(&parse(src), false);
    render.out.0
}

struct Render<'a> {
    out: Out,
    images: &'a HashMap<String, String>,
    lists: std::vec::IntoIter<(bool, bool)>,
    tables: std::vec::IntoIter<Vec<Alignment>>,
    tasks: std::vec::IntoIter<Option<bool>>,
}

impl Render<'_> {
    fn blocks(&mut self, blocks: &[Block], tight: bool) {
        for (i, block) in blocks.iter().enumerate() {
            if i != 0 {
                self.out.raw("\n");
            }
            match block {
                Block::Paragraph(content) if tight => self.inlines(content),
                Block::Paragraph(content) => {
                    self.out.open("p", &[]);
                    self.inlines(content);
                    self.out.close("p");
                }
                Block::Heading { level, content } => {
                    let tag = ["h1", "h2", "h3", "h4", "h5", "h6"][usize::from(*level) - 1];
                    self.out.open(tag, &[]);
                    self.inlines(content);
                    self.out.close(tag);
                }
                Block::List { start, items } => self.list(*start, items),
                Block::Quote(children) => {
                    self.out.open("blockquote", &[]);
                    self.blocks(children, false);
                    self.out.close("blockquote");
                }
                Block::Code { language, text } => {
                    self.out.open("pre", &[]);
                    if let Some(language) = language {
                        self.out
                            .open("code", &[("class", &format!("language-{language}"))]);
                    } else {
                        self.out.open("code", &[]);
                    }
                    self.out.text(text);
                    self.out.raw("</code></pre>");
                }
                Block::Table(table) => self.table(table),
                Block::Rule => self.out.void("hr", &[]),
            }
        }
    }

    fn list(&mut self, start: Option<u64>, items: &[Item]) {
        let (loose, has_tasks) = self.lists.next().unwrap_or_default();
        let tag = if start.is_some() { "ol" } else { "ul" };
        let mut attrs = Vec::new();
        let number;
        if let Some(start) = start.filter(|&n| n != 1) {
            number = start.to_string();
            attrs.push(("start", number.as_str()));
        }
        if has_tasks {
            attrs.push(("class", "contains-task-list"));
        }
        self.out.open(tag, &attrs);
        for (i, item) in items.iter().enumerate() {
            if i != 0 {
                self.out.raw("\n");
            }
            let mut blocks = item.blocks.as_slice();
            if let Some(checked) = self.tasks.next().flatten() {
                self.out.open("li", &[("class", "task-list-item")]);
                let paragraph = match blocks {
                    [Block::Paragraph(content), rest @ ..] if loose => {
                        self.out.open("p", &[]);
                        blocks = rest;
                        Some(content)
                    }
                    _ => None,
                };
                let attrs = [("type", "checkbox"), ("disabled", ""), ("checked", "")];
                self.out
                    .void("input", &attrs[..if checked { 3 } else { 2 }]);
                self.out.raw(" ");
                if let Some(content) = paragraph {
                    self.inlines(content);
                    self.out.close("p");
                    if !blocks.is_empty() {
                        self.out.raw("\n");
                    }
                }
            } else {
                self.out.open("li", &[]);
            }
            self.blocks(blocks, !loose);
            self.out.close("li");
        }
        self.out.close(tag);
    }

    fn table(&mut self, table: &Table) {
        let alignments = self.tables.next().unwrap_or_default();
        self.out.raw("<table><thead>");
        self.row("th", &table.head, &alignments);
        self.out.close("thead");
        if !table.rows.is_empty() {
            self.out.open("tbody", &[]);
            for row in &table.rows {
                self.row("td", row, &alignments);
            }
            self.out.close("tbody");
        }
        self.out.close("table");
    }

    fn row(&mut self, tag: &str, row: &[Vec<Inline>], alignments: &[Alignment]) {
        self.out.open("tr", &[]);
        for (i, cell) in row.iter().enumerate() {
            let style = match alignments.get(i) {
                Some(Alignment::Left) => Some("text-align: left;"),
                Some(Alignment::Center) => Some("text-align: center;"),
                Some(Alignment::Right) => Some("text-align: right;"),
                _ => None,
            };
            if let Some(style) = style {
                self.out.open(tag, &[("style", style)]);
            } else {
                self.out.open(tag, &[]);
            }
            self.inlines(cell);
            self.out.close(tag);
        }
        self.out.close("tr");
    }

    fn inlines(&mut self, content: &[Inline]) {
        for inline in content {
            match inline {
                Inline::Text { text, style, .. } => {
                    let tags = [
                        ("strong", style.bold),
                        ("em", style.italic),
                        ("del", style.strike),
                    ];
                    for (tag, on) in tags {
                        if on {
                            self.out.open(tag, &[]);
                        }
                    }
                    self.out.text(text);
                    for (tag, on) in tags.into_iter().rev() {
                        if on {
                            self.out.close(tag);
                        }
                    }
                }
                Inline::Code(text) => {
                    self.out.open("code", &[]);
                    self.out.text(text);
                    self.out.close("code");
                }
                Inline::Link { href, children } => self.link(href, children),
                Inline::Image { src, alt } => {
                    let src = self.images.get(src).unwrap_or(src);
                    self.out.void("img", &[("src", src), ("alt", alt)]);
                }
                Inline::Break => self.out.void("br", &[]),
            }
        }
    }

    fn link(&mut self, href: &str, children: &[Inline]) {
        let normalized = href.replace(['\t', '\r', '\n'], "");
        let scheme = normalized
            .trim_start()
            .split_once(':')
            .map_or("", |(scheme, _)| scheme);
        if normalized.is_empty()
            || scheme.eq_ignore_ascii_case("javascript")
            || scheme.eq_ignore_ascii_case("vbscript")
        {
            self.out.open("span", &[]);
            self.inlines(children);
            self.out.close("span");
        } else if is_external(href) {
            self.external(href, children);
        } else {
            self.out.open(
                "a",
                &[
                    ("href", href),
                    ("rel", "noopener noreferrer"),
                    ("target", "_blank"),
                ],
            );
            self.inlines(children);
            self.out.close("a");
        }
    }

    fn external(&mut self, href: &str, children: &[Inline]) {
        let label = label(&plain(children), href);
        let lead = label.trim_start();
        let split = label.len() - lead.len() + lead.chars().next().map_or(0, char::len_utf8);
        let (head, tail) = label.split_at(split);
        self.out.open(
            "a",
            &[
                ("class", "InlineReference__external"),
                ("data-slot", "inline-reference"),
                ("data-kind", "external"),
                ("href", href),
                ("rel", "noopener noreferrer"),
                ("target", "_blank"),
            ],
        );
        self.out.raw(concat!(
            "<span class=\"InlineReference__lead\">",
            "<span class=\"InlineReference__slot\" data-favicon=\"fallback\" ",
            "data-slot=\"inline-reference-icon\" aria-hidden=\"true\">",
            "<span class=\"InlineReference__globe\">"
        ));
        self.out.raw(GLOBE_SVG);
        self.out
            .raw("</span></span><span class=\"InlineReference__label\">");
        self.out.text(head);
        self.out
            .raw("</span></span><span class=\"InlineReference__label\">");
        self.out.text(tail);
        self.out.raw("</span></a>");
    }
}
