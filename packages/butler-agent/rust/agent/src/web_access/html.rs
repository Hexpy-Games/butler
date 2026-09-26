use std::collections::HashMap;

mod extraction;

pub(super) use extraction::extract_readable_html;

#[derive(Clone, Debug)]
pub(super) struct HtmlTag {
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) name: String,
    pub(super) closing: bool,
    pub(super) self_closing: bool,
    pub(super) attributes: HashMap<String, String>,
}

pub(super) fn parse_tags(html: &str) -> Vec<HtmlTag> {
    let mut tags = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = html[cursor..].find('<') {
        let start = cursor + relative;
        if html[start..].starts_with("<!--") {
            cursor = html[start + 4..]
                .find("-->")
                .map_or(html.len(), |end| start + 4 + end + 3);
            continue;
        }
        let Some(end) = tag_end(html, start) else {
            break;
        };
        let inside = html[start + 1..end - 1].trim();
        if inside.is_empty() || inside.starts_with('!') || inside.starts_with('?') {
            cursor = end;
            continue;
        }
        let closing = inside.starts_with('/');
        let content = inside.strip_prefix('/').unwrap_or(inside).trim_start();
        let name_end = content
            .find(|ch: char| ch.is_ascii_whitespace() || ch == '/')
            .unwrap_or(content.len());
        let name = content[..name_end].to_ascii_lowercase();
        if name.is_empty() || !name.bytes().all(is_tag_name_byte) {
            cursor = end;
            continue;
        }
        let attributes = if closing {
            HashMap::new()
        } else {
            parse_attributes(&content[name_end..])
        };
        let self_closing = content.trim_end().ends_with('/');
        tags.push(HtmlTag {
            start,
            end,
            name,
            closing,
            self_closing,
            attributes,
        });
        cursor = end;
    }
    tags
}

pub(super) fn strip_html(html: &str) -> String {
    let tags = parse_tags(html);
    let mut text = String::new();
    let mut cursor = 0;
    let mut index = 0;
    while index < tags.len() {
        let tag = &tags[index];
        if !tag.closing
            && is_skipped(&tag.name)
            && let Some(end_index) = matching_close(&tags, index)
        {
            cursor = tags[end_index].end;
            index = end_index + 1;
            continue;
        }
        text.push_str(&decode_entities(&html[cursor..tag.start]));
        if is_block(&tag.name) {
            text.push('\n');
        }
        if !tag.closing && tag.name == "li" {
            text.push_str("- ");
        } else if !tag.closing && is_heading(&tag.name) {
            text.push_str("# ");
        }
        cursor = tag.end;
        index += 1;
    }
    text.push_str(&decode_entities(&html[cursor..]));
    normalize_lines(&text)
}

pub(super) fn title_from_html(html: &str) -> Option<String> {
    let tags = parse_tags(html);
    let index = tags
        .iter()
        .position(|tag| !tag.closing && tag.name == "title")?;
    let inner = element_inner(html, &tags, index)?;
    let title = strip_html(inner);
    (!title.is_empty()).then_some(title)
}

pub(super) fn element_inner<'a>(html: &'a str, tags: &[HtmlTag], index: usize) -> Option<&'a str> {
    let open = tags.get(index)?;
    let close = matching_close(tags, index)?;
    Some(&html[open.end..tags[close].start])
}

pub(super) fn matching_close(tags: &[HtmlTag], index: usize) -> Option<usize> {
    let open = tags.get(index)?;
    if open.closing || open.self_closing {
        return None;
    }
    let mut depth = 0_usize;
    for (current, tag) in tags.iter().enumerate().skip(index) {
        if tag.name != open.name {
            continue;
        }
        if tag.closing {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(current);
            }
        } else if !tag.self_closing {
            depth += 1;
        }
    }
    None
}

pub(super) fn decode_entities(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;
    while let Some(relative) = value[cursor..].find('&') {
        let start = cursor + relative;
        output.push_str(&value[cursor..start]);
        let Some(relative_end) = value[start..].find(';') else {
            output.push_str(&value[start..]);
            return output;
        };
        let end = start + relative_end;
        let entity = &value[start + 1..end];
        if let Some(decoded) = decode_entity(entity) {
            output.push(decoded);
            cursor = end + 1;
        } else {
            output.push_str(&value[start..=end]);
            cursor = end + 1;
        }
    }
    output.push_str(&value[cursor..]);
    output
}

pub(super) fn compact(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn tag_end(html: &str, start: usize) -> Option<usize> {
    let mut quote = None;
    for (offset, byte) in html.as_bytes().iter().enumerate().skip(start + 1) {
        match (quote, *byte) {
            (Some(current), byte) if current == byte => quote = None,
            (None, b'\'' | b'"') => quote = Some(*byte),
            (None, b'>') => return Some(offset + 1),
            _ => {}
        }
    }
    None
}

fn parse_attributes(input: &str) -> HashMap<String, String> {
    let bytes = input.as_bytes();
    let mut attributes = HashMap::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        while cursor < bytes.len() && (bytes[cursor].is_ascii_whitespace() || bytes[cursor] == b'/')
        {
            cursor += 1;
        }
        let start = cursor;
        while cursor < bytes.len()
            && !bytes[cursor].is_ascii_whitespace()
            && !matches!(bytes[cursor], b'=' | b'/' | b'>')
        {
            cursor += 1;
        }
        if start == cursor {
            cursor += 1;
            continue;
        }
        let key = input[start..cursor].to_ascii_lowercase();
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let mut value = String::new();
        if bytes.get(cursor) == Some(&b'=') {
            cursor += 1;
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            if let Some(quote @ (b'\'' | b'"')) = bytes.get(cursor).copied() {
                cursor += 1;
                let value_start = cursor;
                while cursor < bytes.len() && bytes[cursor] != quote {
                    cursor += 1;
                }
                value = decode_entities(&input[value_start..cursor]);
                cursor = cursor.saturating_add(1);
            } else {
                let value_start = cursor;
                while cursor < bytes.len()
                    && !bytes[cursor].is_ascii_whitespace()
                    && bytes[cursor] != b'>'
                {
                    cursor += 1;
                }
                value = decode_entities(&input[value_start..cursor]);
            }
        }
        attributes.entry(key).or_insert(value);
    }
    attributes
}

fn decode_entity(value: &str) -> Option<char> {
    match value {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" | "#39" | "#x27" | "#X27" => Some('\''),
        "nbsp" => Some(' '),
        "ndash" => Some('–'),
        "mdash" => Some('—'),
        "hellip" => Some('…'),
        _ if value.starts_with("#x") || value.starts_with("#X") => {
            u32::from_str_radix(&value[2..], 16)
                .ok()
                .and_then(char::from_u32)
        }
        _ if value.starts_with('#') => value[1..].parse::<u32>().ok().and_then(char::from_u32),
        _ => None,
    }
}

fn is_tag_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b':' | b'_')
}

fn is_skipped(name: &str) -> bool {
    matches!(name, "script" | "style" | "noscript" | "svg" | "head")
}

fn is_block(name: &str) -> bool {
    matches!(
        name,
        "address"
            | "article"
            | "blockquote"
            | "br"
            | "div"
            | "footer"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "header"
            | "hr"
            | "li"
            | "main"
            | "ol"
            | "p"
            | "pre"
            | "section"
            | "table"
            | "td"
            | "th"
            | "tr"
            | "ul"
    )
}

fn is_heading(name: &str) -> bool {
    matches!(name, "h1" | "h2" | "h3" | "h4" | "h5" | "h6")
}

fn normalize_lines(value: &str) -> String {
    let lines = value
        .lines()
        .map(compact)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    lines.join("\n\n")
}
