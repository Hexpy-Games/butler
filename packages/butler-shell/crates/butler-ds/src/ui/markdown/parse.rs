//! Markdown source to [`Block`]s: `pulldown-cmark` with the GFM extensions `remark-gfm`
//! provides (tables, strikethrough, task lists; autolinks in `text`), with the pipeline's two
//! rules: `~text~` is not strikethrough (`singleTilde: false`) and `**text.**word` is bold.
//! Raw HTML shows as text, as react-markdown renders it without `rehype-raw`.
use std::ops::Range;

use pulldown_cmark::{Alignment, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

use super::model::{Align, Block, Inline, Item, Style, Table, slice};
use super::text;

/// Parses `source`.
pub fn parse(source: &str) -> Vec<Block> {
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let events = merge(
        Parser::new_ext(source, options)
            .into_offset_iter()
            .collect(),
    );
    Parse {
        source,
        events,
        at: 0,
    }
    .blocks()
}

type Spanned<'a> = (Event<'a>, Range<usize>);

/// Joins adjacent text, soft breaks and inline HTML into one text event, as mdast has one
/// text node where the parser splits at delimiters, escapes and line ends.
fn merge<'a>(events: Vec<Spanned<'a>>) -> Vec<Spanned<'a>> {
    let mut out: Vec<Spanned<'a>> = Vec::with_capacity(events.len());
    for (event, range) in events {
        let piece = match &event {
            Event::Text(text) => Some(text.to_string()),
            Event::SoftBreak => Some("\n".to_owned()),
            Event::InlineHtml(html) => Some(html.to_string()),
            _ => None,
        };
        let Some(piece) = piece else {
            out.push((event, range));
            continue;
        };
        if let Some((Event::Text(last), last_range)) = out.last_mut()
            && last_range.end == range.start
        {
            let mut joined = last.to_string();
            joined.push_str(&piece);
            *last = joined.into();
            last_range.end = range.end;
            continue;
        }
        out.push((Event::Text(piece.into()), range));
    }
    out
}

struct Parse<'a> {
    source: &'a str,
    events: Vec<Spanned<'a>>,
    at: usize,
}

fn align(alignment: Alignment) -> Align {
    match alignment {
        Alignment::None | Alignment::Left => Align::Start,
        Alignment::Center => Align::Center,
        Alignment::Right => Align::End,
    }
}

fn level(heading: HeadingLevel) -> u8 {
    match heading {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

impl<'a> Parse<'a> {
    fn peek(&self) -> Option<&Event<'a>> {
        self.events.get(self.at).map(|(event, _)| event)
    }

    fn next(&mut self) -> Option<Spanned<'a>> {
        let event = self.events.get(self.at).cloned();
        self.at += 1;
        event
    }

    /// Blocks up to the end of the container being parsed (its end event is consumed).
    fn blocks(&mut self) -> Vec<Block> {
        let mut blocks = Vec::new();
        while let Some(event) = self.peek() {
            if matches!(event, Event::End(_)) {
                self.at += 1;
                break;
            }
            if let Some(block) = self.block() {
                blocks.push(block);
            }
        }
        blocks
    }

    fn block(&mut self) -> Option<Block> {
        let (event, _) = self.next()?;
        match event {
            Event::Start(Tag::Paragraph) => {
                Some(Block::Paragraph(self.inlines(Style::default(), false)))
            }
            Event::Start(Tag::Heading { level: l, .. }) => Some(Block::Heading {
                level: level(l),
                content: self.inlines(Style::default(), false),
            }),
            Event::Start(Tag::BlockQuote(_)) => Some(Block::Quote(self.blocks())),
            Event::Start(Tag::CodeBlock(kind)) => Some(self.code(&kind)),
            Event::Start(Tag::List(start)) => Some(self.list(start)),
            Event::Start(Tag::Table(aligns)) => Some(self.table(&aligns)),
            Event::Rule => Some(Block::Rule),
            Event::Start(Tag::HtmlBlock) => self.html(),
            Event::Start(_) => {
                // Anything else (footnotes, definitions, metadata) renders as its children.
                let inner = self.blocks();
                (!inner.is_empty()).then_some(Block::Quote(inner))
            }
            _ => {
                self.at -= 1;
                Some(Block::Paragraph(self.implicit()))
            }
        }
    }

    /// Inline events with no paragraph around them (a tight list item).
    fn implicit(&mut self) -> Vec<Inline> {
        let mut nodes = Vec::new();
        while self.peek().is_some_and(starts_inline) {
            if let Some((event, range)) = self.next() {
                self.inline_event(event, &range, Style::default(), false, &mut nodes);
            }
        }
        nodes
    }

    fn html(&mut self) -> Option<Block> {
        let mut raw = String::new();
        while let Some((event, _)) = self.next() {
            match event {
                Event::End(TagEnd::HtmlBlock) => break,
                Event::Html(text) | Event::Text(text) => raw.push_str(&text),
                _ => {}
            }
        }
        let raw = raw.trim_end().to_owned();
        (!raw.is_empty()).then(|| Block::Paragraph(vec![plain_text(raw)]))
    }

    fn code(&mut self, kind: &CodeBlockKind<'_>) -> Block {
        let mut text = String::new();
        while let Some((event, _)) = self.next() {
            match event {
                Event::End(TagEnd::CodeBlock) => break,
                Event::Text(chunk) => text.push_str(&chunk),
                _ => {}
            }
        }
        let language = match kind {
            CodeBlockKind::Fenced(info) => info
                .split_whitespace()
                .next()
                .map(str::to_owned)
                .filter(|lang| !lang.is_empty()),
            CodeBlockKind::Indented => None,
        };
        Block::Code { language, text }
    }

    fn list(&mut self, start: Option<u64>) -> Block {
        let mut items = Vec::new();
        while let Some(event) = self.peek() {
            match event {
                Event::Start(Tag::Item) => {
                    self.at += 1;
                    items.push(self.item());
                }
                Event::End(_) => {
                    self.at += 1;
                    break;
                }
                _ => self.at += 1,
            }
        }
        Block::List { start, items }
    }

    fn item(&mut self) -> Item {
        let checked = match self.peek() {
            Some(Event::TaskListMarker(done)) => {
                let done = *done;
                self.at += 1;
                Some(done)
            }
            _ => None,
        };
        Item {
            checked,
            blocks: self.blocks(),
        }
    }

    fn table(&mut self, aligns: &[Alignment]) -> Block {
        let mut head = Vec::new();
        let mut rows: Vec<Vec<Vec<Inline>>> = Vec::new();
        let mut in_head = false;
        while let Some((event, _)) = self.next() {
            match event {
                Event::Start(Tag::TableHead) => in_head = true,
                Event::End(TagEnd::TableHead) => in_head = false,
                Event::Start(Tag::TableRow) => rows.push(Vec::new()),
                Event::Start(Tag::TableCell) => {
                    let cell = self.inlines(Style::default(), false);
                    match (in_head, rows.last_mut()) {
                        (false, Some(row)) => row.push(cell),
                        _ => head.push(cell),
                    }
                }
                Event::End(TagEnd::Table) => break,
                _ => {}
            }
        }
        Table {
            aligns: aligns.iter().copied().map(align).collect(),
            head,
            rows,
        }
        .into()
    }

    /// Inline nodes up to the end of the container being parsed (its end event is consumed).
    fn inlines(&mut self, style: Style, in_link: bool) -> Vec<Inline> {
        let mut nodes = Vec::new();
        while let Some((event, range)) = self.next() {
            if matches!(event, Event::End(_)) {
                break;
            }
            self.inline_event(event, &range, style, in_link, &mut nodes);
        }
        nodes
    }

    fn inline_event(
        &mut self,
        event: Event<'a>,
        range: &Range<usize>,
        style: Style,
        in_link: bool,
        nodes: &mut Vec<Inline>,
    ) {
        match event {
            Event::Text(text) | Event::Html(text) => {
                let exact = (slice(self.source, range) == &*text).then_some(range.start);
                nodes.extend(text::run(&text, style, exact, in_link));
            }
            Event::Code(code) => nodes.push(Inline::Code(code.to_string())),
            Event::HardBreak => nodes.push(Inline::Break),
            Event::Start(Tag::Emphasis) => {
                nodes.extend(self.inlines(
                    Style {
                        italic: true,
                        ..style
                    },
                    in_link,
                ));
            }
            Event::Start(Tag::Strong) => {
                nodes.extend(self.inlines(
                    Style {
                        bold: true,
                        ..style
                    },
                    in_link,
                ));
            }
            Event::Start(Tag::Strikethrough) => {
                let double = slice(self.source, range).starts_with("~~");
                let inner = self.inlines(
                    Style {
                        strike: double,
                        ..style
                    },
                    in_link,
                );
                if double {
                    nodes.extend(inner);
                } else {
                    nodes.push(plain_text("~".to_owned()));
                    nodes.extend(inner);
                    nodes.push(plain_text("~".to_owned()));
                }
            }
            Event::Start(Tag::Link { dest_url, .. }) => nodes.push(Inline::Link {
                href: dest_url.to_string(),
                children: self.inlines(style, true),
            }),
            Event::Start(Tag::Image { dest_url, .. }) => {
                let alt = super::model::plain(&self.inlines(style, true));
                nodes.push(Inline::Image {
                    src: dest_url.to_string(),
                    alt,
                });
            }
            _ => {}
        }
    }
}

/// Whether `event` is an inline node (a tight list item holds these without a paragraph).
fn starts_inline(event: &Event<'_>) -> bool {
    matches!(
        event,
        Event::Text(_)
            | Event::Code(_)
            | Event::HardBreak
            | Event::Start(
                Tag::Emphasis
                    | Tag::Strong
                    | Tag::Strikethrough
                    | Tag::Link { .. }
                    | Tag::Image { .. }
            )
    )
}

fn plain_text(text: String) -> Inline {
    Inline::Text {
        text,
        style: Style::default(),
        source: None,
    }
}

impl From<Table> for Block {
    fn from(table: Table) -> Self {
        Self::Table(table)
    }
}
