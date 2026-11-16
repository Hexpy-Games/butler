//! Spec file format parser v1 from the Canon design.
use super::*;
use std::collections::HashSet;

pub(super) struct Parsed<'a> {
    pub title: Option<&'a str>,
    pub criteria: Vec<Criterion>,
}

pub(super) fn parse(body: &str) -> Result<Parsed<'_>> {
    let mut parsed = Parsed {
        title: None,
        criteria: Vec::new(),
    };
    let mut part = "";
    let mut fenced = false;
    let mut ids = HashSet::new();
    for (index, line) in body.lines().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        if index == 0 {
            parsed.title = line.strip_prefix("# ").map(str::trim);
        }
        if let Some(heading) = line.strip_prefix("## ") {
            part = heading.trim();
        }
        let Some(item) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        else {
            continue;
        };
        let item = item.trim_start();
        let Some(id) = item.split_whitespace().next() else {
            continue;
        };
        let Some((prefix, number)) = id.split_once('-') else {
            continue;
        };
        if !matches!(prefix.as_bytes().first(), Some(b'A'..=b'Z'))
            || !prefix
                .bytes()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
            || number.is_empty()
            || !number.bytes().all(|c| c.is_ascii_digit())
        {
            continue;
        }
        let text = item[id.len()..].trim();
        if text.is_empty() {
            continue;
        }
        if !ids.insert(id) {
            return Err(Error::Invalid("duplicate criterion id"));
        }
        parsed.criteria.push(Criterion {
            id: id.into(),
            part_id: part.into(),
            text: text.into(),
        });
    }
    Ok(parsed)
}
