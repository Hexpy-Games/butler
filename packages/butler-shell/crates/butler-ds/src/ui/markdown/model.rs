//! The document a markdown source parses to (mdast as react-markdown renders it): blocks, and
//! inline runs that carry their own emphasis, code, link and image nodes.
use std::ops::Range;

/// Emphasis a run of text carries.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Style {
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Inline {
    Text {
        text: String,
        style: Style,
        /// Where the text starts in the source (the streaming reveal maps chunks onto it).
        source: Option<usize>,
    },
    Code(String),
    Link {
        href: String,
        children: Vec<Inline>,
    },
    Image {
        src: String,
        alt: String,
    },
    /// `<br>`: a hard line break.
    Break,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Align {
    #[default]
    Start,
    Center,
    End,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    /// `- [ ]` / `- [x]`: a GFM task item.
    pub checked: Option<bool>,
    pub blocks: Vec<Block>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Table {
    pub aligns: Vec<Align>,
    pub head: Vec<Vec<Inline>>,
    pub rows: Vec<Vec<Vec<Inline>>>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    Paragraph(Vec<Inline>),
    Heading {
        level: u8,
        content: Vec<Inline>,
    },
    /// `start` is the first number of an ordered list.
    List {
        start: Option<u64>,
        items: Vec<Item>,
    },
    Quote(Vec<Block>),
    Code {
        language: Option<String>,
        text: String,
    },
    Table(Table),
    Rule,
}

/// The plain text of inline nodes (a link's label, an image's alt).
pub fn plain(nodes: &[Inline]) -> String {
    let mut out = String::new();
    for node in nodes {
        match node {
            Inline::Text { text, .. } | Inline::Code(text) => out.push_str(text),
            Inline::Link { children, .. } => out.push_str(&plain(children)),
            Inline::Image { alt, .. } => out.push_str(alt),
            Inline::Break => out.push('\n'),
        }
    }
    out
}

/// `range` of `source`, or the empty string for an out-of-range pair.
pub(super) fn slice<'a>(source: &'a str, range: &Range<usize>) -> &'a str {
    source.get(range.clone()).unwrap_or("")
}
