//! Keep table headers in every source chunk that continues their rows.
use pulldown_cmark::{Event, Options, Parser, Tag};
use std::ops::Range;

pub(super) struct TableContext {
    pub start: usize,
    pub header_end: usize,
    pub end: usize,
    pub header: String,
}

pub(super) fn contexts(markdown: &str) -> Vec<TableContext> {
    let mut contexts = Vec::new();
    let mut html: Option<Range<usize>> = None;
    for (event, range) in Parser::new_ext(markdown, Options::ENABLE_TABLES).into_offset_iter() {
        if matches!(event, Event::Html(_)) {
            if let Some(previous) = &mut html
                && previous.end == range.start
            {
                previous.end = range.end;
            } else {
                flush_html(markdown, html.take(), &mut contexts);
                html = Some(range);
            }
            continue;
        }
        flush_html(markdown, html.take(), &mut contexts);
        if matches!(event, Event::Start(Tag::Table(_))) {
            let header_end = range.start
                + markdown[range.clone()]
                    .split_inclusive('\n')
                    .take(2)
                    .map(str::len)
                    .sum::<usize>();
            contexts.push(context(markdown, range.start, header_end, range.end));
        }
    }
    flush_html(markdown, html, &mut contexts);
    contexts.sort_by_key(|table| table.start);
    contexts
}

fn flush_html(markdown: &str, range: Option<Range<usize>>, output: &mut Vec<TableContext>) {
    let Some(range) = range else {
        return;
    };
    let html = &markdown[range.clone()];
    let tags = super::super::html::parse_tags(html);
    let mut index = 0;
    while index < tags.len() {
        let tag = &tags[index];
        if !tag.closing
            && tag.name == "table"
            && let Some(close) = super::super::html::matching_close(&tags, index)
        {
            if let Some(row) =
                (index + 1..close).find(|i| !tags[*i].closing && tags[*i].name == "tr")
                && let Some(row_end) = super::super::html::matching_close(&tags, row)
                && tags[row..row_end]
                    .iter()
                    .any(|t| !t.closing && t.name == "th")
            {
                output.push(context(
                    markdown,
                    range.start + tag.start,
                    range.start + tags[row_end].end,
                    range.start + tags[close].end,
                ));
            }
            index = close + 1;
        } else {
            index += 1;
        }
    }
}

fn context(markdown: &str, start: usize, header_end: usize, end: usize) -> TableContext {
    TableContext {
        start: markdown[..start].encode_utf16().count(),
        header_end: markdown[..header_end].encode_utf16().count(),
        end: markdown[..end].encode_utf16().count(),
        header: markdown[start..header_end].trim_end().to_owned(),
    }
}
