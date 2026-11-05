//! The supported CSS scopes; unrelated rules never supply token declarations.
use std::collections::BTreeMap;

#[derive(Clone)]
pub(crate) struct Declaration {
    pub name: String,
    pub value: String,
    pub line: usize,
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent CSS selector and media conditions"
)]
#[derive(Clone, Default)]
pub(crate) struct Condition {
    pub dark: Option<bool>,
    pub solid: bool,
    pub compact: bool,
    pub density: Option<usize>,
    pub reduced: bool,
    pub explicit_motion: bool,
}

pub(crate) struct Block {
    pub condition: Condition,
    pub declarations: Vec<Declaration>,
}

pub(crate) fn read(source: &str) -> Result<Vec<Block>, String> {
    let clean = strip_comments(source)?;
    let mut blocks = Vec::new();
    walk(&clean, 0, &Condition::default(), &mut blocks)?;
    let motion = |explicit| {
        blocks
            .iter()
            .filter(|b| b.condition.reduced && b.condition.explicit_motion == explicit)
            .flat_map(|b| &b.declarations)
            .map(|d| (&d.name, d.value.split_whitespace().collect::<String>()))
            .collect::<BTreeMap<_, _>>()
    };
    if motion(false) != motion(true) {
        return Err("reduced-motion media and data-motion declarations differ".into());
    }
    Ok(blocks)
}

fn strip_comments(source: &str) -> Result<String, String> {
    let mut result = String::new();
    let mut rest = source;
    while let Some(start) = rest.find("/*") {
        result.push_str(&rest[..start]);
        let end = rest[start + 2..].find("*/").ok_or("unclosed CSS comment")? + start + 4;
        result.extend(
            rest[start..end]
                .chars()
                .map(|c| if c == '\n' { '\n' } else { ' ' }),
        );
        rest = &rest[end..];
    }
    result.push_str(rest);
    Ok(result)
}

fn walk(
    source: &str,
    offset: usize,
    parent: &Condition,
    blocks: &mut Vec<Block>,
) -> Result<(), String> {
    let mut pos = 0;
    while let Some(open) = source[pos..].find('{').map(|v| v + pos) {
        let start = source[pos..open].rfind(';').map_or(pos, |v| pos + v + 1);
        let selector = source[start..open]
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let close = closing(source, open, '{', '}')?;
        let body = &source[open + 1..close];
        let selector_start =
            start + source[start..open].len() - source[start..open].trim_start().len();
        let line = offset
            + source[..selector_start]
                .bytes()
                .filter(|c| *c == b'\n')
                .count()
            + 1;
        if let Some(condition) = condition(&selector, parent)? {
            let offset = offset + source[..=open].bytes().filter(|c| *c == b'\n').count();
            if selector.starts_with('@') {
                walk(body, offset, &condition, blocks)?;
            } else {
                blocks.push(Block {
                    condition,
                    declarations: declarations(body, offset)?,
                });
            }
        } else if !skipped(&selector) && has_declarations(body)? {
            return Err(format!("unsupported selector {selector} at line {line}"));
        }
        pos = close + 1;
    }
    Ok(())
}

fn has_declarations(body: &str) -> Result<bool, String> {
    if !declarations(body, 0)?.is_empty() {
        return Ok(true);
    }
    let mut pos = 0;
    while let Some(open) = body[pos..].find('{').map(|i| pos + i) {
        let close = closing(body, open, '{', '}')?;
        if has_declarations(&body[open + 1..close])? {
            return Ok(true);
        }
        pos = close + 1;
    }
    Ok(false)
}

fn skipped(selector: &str) -> bool {
    selector.starts_with("@supports")
        || selector == "@media (width <= 760px)"
        || selector == "@media (pointer: coarse)"
        || selector.contains("[data-viewport=\"desktop\"]")
        || !selector.starts_with(['@', '.', '[', ':'])
}

fn condition(selector: &str, parent: &Condition) -> Result<Option<Condition>, String> {
    let mut c = parent.clone();
    match selector {
        ":root" | ".theme-dark, .theme-light" => {}
        ".theme-light" => c.dark = Some(false),
        ".theme-dark" => c.dark = Some(true),
        ".sidebar-solid" => c.solid = true,
        ".theme-light.sidebar-solid" => {
            c.dark = Some(false);
            c.solid = true;
        }
        ".theme-dark.sidebar-solid" => {
            c.dark = Some(true);
            c.solid = true;
        }
        "@media (prefers-reduced-motion: reduce)" => c.reduced = true,
        "@media (width <= 640px)" | "@media (width <= 640px), (pointer: coarse)" => {
            c.compact = true;
        }
        ":root:has(#root[data-motion=\"reduced\"]), [data-motion=\"reduced\"]"
        | "[data-motion=\"reduced\"]" => {
            c.reduced = true;
            c.explicit_motion = true;
        }
        _ => {
            if let Some(density) = selector
                .strip_prefix("[data-sidebar-density=")
                .and_then(|s| s.strip_suffix(']'))
            {
                c.density = Some(match density.trim_matches(['\'', '"']) {
                    "compact" => 0,
                    "comfortable" => 1,
                    "touch" => 2,
                    _ => return Err(format!("unknown sidebar density {density}")),
                });
            } else {
                return Ok(None);
            }
        }
    }
    Ok(Some(c))
}

fn declarations(body: &str, offset: usize) -> Result<Vec<Declaration>, String> {
    let mut result = Vec::new();
    let mut start = 0;
    for (end, _) in body.match_indices(';') {
        let text = &body[start..end];
        if let Some((name, value)) = text.trim().split_once(':')
            && name.starts_with("--")
        {
            let first = start + text.find(name).ok_or("missing declaration name")?;
            result.push(Declaration {
                name: name.into(),
                value: value.trim().into(),
                line: offset + body[..first].bytes().filter(|c| *c == b'\n').count() + 1,
            });
        }
        start = end + 1;
    }
    Ok(result)
}

pub(crate) fn closing(text: &str, open: usize, left: char, right: char) -> Result<usize, String> {
    let mut depth = 0;
    let mut quote = None;
    for (i, c) in text[open..].char_indices() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
        }
        if c == left {
            depth += 1;
        }
        if c == right {
            depth -= 1;
            if depth == 0 {
                return Ok(open + i);
            }
        }
    }
    Err(format!("unclosed {left}"))
}

pub(crate) fn split(text: &str, separator: char) -> Vec<&str> {
    let mut depth = 0;
    let mut quote = None;
    let mut start = 0;
    let mut parts = Vec::new();
    for (i, c) in text.char_indices() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => {}
        }
        if depth == 0 && (c == separator || (separator == ' ' && c.is_whitespace())) {
            if !text[start..i].trim().is_empty() {
                parts.push(text[start..i].trim());
            }
            start = i + c.len_utf8();
        }
    }
    if !text[start..].trim().is_empty() {
        parts.push(text[start..].trim());
    }
    parts
}
