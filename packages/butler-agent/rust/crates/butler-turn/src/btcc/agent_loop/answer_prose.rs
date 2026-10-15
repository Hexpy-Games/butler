//! A reply shows a comparison once: a Markdown table in the prose that repeats
//! an answer-blocks table (the same items, row for row) is dropped, because
//! the block already shows it below the reply.
use serde_json::Value;

/// The reply text without Markdown tables whose rows name the same items, in
/// the same number, as a table block of the accepted answer-block sets.
pub(super) fn without_block_tables(content: &str, sets: &[Value]) -> String {
    let shown: Vec<Vec<String>> = sets
        .iter()
        .filter_map(|set| set.pointer("/spec/blocks").and_then(Value::as_array))
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("table"))
        .map(|block| {
            block
                .get("rows")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|row| row.get(0).map_or_else(String::new, cell_key))
                .collect()
        })
        .collect();
    if shown.is_empty() {
        return content.to_owned();
    }
    let lines: Vec<&str> = content.lines().collect();
    let mut kept: Vec<&str> = Vec::with_capacity(lines.len());
    let (mut rest, mut fenced, mut removed) = (lines.as_slice(), false, false);
    while let Some((line, tail)) = rest.split_first() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
        }
        let table = if fenced { None } else { table_rows(rest) };
        match table {
            Some((rows, after)) if repeats(rows, &shown) => {
                rest = after;
                removed = true;
            }
            _ => {
                kept.push(line);
                rest = tail;
            }
        }
    }
    if removed {
        collapse_blank_runs(&kept)
    } else {
        content.to_owned()
    }
}

/// The data rows of the Markdown table starting the lines (a pipe row then a
/// delimiter row), with the lines after it, when one starts there.
fn table_rows<'a, 'b>(lines: &'a [&'b str]) -> Option<(&'a [&'b str], &'a [&'b str])> {
    let [header, delimiter, body @ ..] = lines else {
        return None;
    };
    let delimiter = delimiter.trim();
    let is_delimiter = delimiter.contains('-')
        && delimiter
            .chars()
            .all(|c| matches!(c, '|' | '-' | ':' | ' ' | '\t'));
    if !header.trim().starts_with('|') || !delimiter.starts_with('|') || !is_delimiter {
        return None;
    }
    let count = body
        .iter()
        .take_while(|line| line.trim().starts_with('|'))
        .count();
    body.split_at_checked(count)
}

/// Whether the Markdown rows name the same items as some block table: as many
/// rows, each first cell naming the block row's first cell or contained in it.
fn repeats(rows: &[&str], shown: &[Vec<String>]) -> bool {
    let keys: Vec<String> = rows.iter().map(|row| markdown_key(row)).collect();
    !keys.is_empty()
        && shown.iter().any(|block| {
            block.len() == keys.len()
                && block.iter().zip(&keys).all(|(cell, key)| {
                    !cell.is_empty()
                        && !key.is_empty()
                        && (key.contains(cell.as_str()) || cell.contains(key.as_str()))
                })
        })
}

fn markdown_key(row: &str) -> String {
    let cell = row.trim().trim_start_matches('|').split('|').next();
    normalized(cell.unwrap_or_default())
}

fn cell_key(cell: &Value) -> String {
    match cell {
        Value::String(text) => normalized(text),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

/// Lower-case words without Markdown emphasis, code marks or link targets.
fn normalized(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut target = false;
    let mut previous = ' ';
    for character in text.chars() {
        if target {
            target = character != ')';
        } else if character == '(' && previous == ']' {
            target = true;
        } else if !matches!(character, '*' | '_' | '`' | '[' | ']') {
            plain.push(character);
        }
        previous = character;
    }
    plain
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Joins the kept lines, leaving at most one blank line where a table was.
fn collapse_blank_runs(lines: &[&str]) -> String {
    let mut out = String::new();
    let mut blank = false;
    for line in lines {
        let empty = line.trim().is_empty();
        if empty && blank {
            continue;
        }
        blank = empty;
        out.push_str(line);
        out.push('\n');
    }
    out.trim_end().to_owned()
}
