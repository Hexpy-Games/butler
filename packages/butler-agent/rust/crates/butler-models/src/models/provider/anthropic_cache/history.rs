//! Byte-preserving history blocks. Separators belong to the following block,
//! so appending a turn does not alter the previous turn's final block.
use serde_json::{Value, json};

pub(super) fn blocks(
    text: &str,
    boundary: usize,
    diagnostics: Option<&Value>,
) -> (Vec<Value>, usize) {
    let Some((start, end)) = history_range(text, boundary, diagnostics) else {
        return (vec![block(&text[..boundary])], boundary);
    };
    let history = &text[start..end];
    let mut offsets = Vec::new();
    let mut offset = start;
    for line in history.split_inclusive('\n') {
        if turn_header(line) {
            offsets.push(if offset == start { offset } else { offset - 1 });
        }
        offset += line.len();
    }
    if offsets.is_empty() {
        return (vec![block(&text[..boundary])], boundary);
    }
    // A bounded window may gain/change a dropped-turn digest. It belongs to
    // history, never the independently cacheable stable documents prefix.
    let mut output = vec![block(&text[..start])];
    if offsets[0] > start {
        output.push(block(&text[start..offsets[0]]));
    }
    // Keep every turn append-only; the previous breakpoint is one block back.
    for (index, begin) in offsets.iter().enumerate() {
        let finish = offsets.get(index + 1).copied().unwrap_or(end);
        output.push(block(&text[*begin..finish]));
    }
    (output, end)
}

fn block(text: &str) -> Value {
    json!({"type":"text","text":text})
}

fn history_range(
    text: &str,
    boundary: usize,
    diagnostics: Option<&Value>,
) -> Option<(usize, usize)> {
    let sections = diagnostics?["inputSections"].as_array()?;
    let mut offset = 0usize;
    for section in sections {
        let bytes = usize::try_from(section["bytes"].as_u64()?).ok()?;
        let end = offset.checked_add(bytes)?;
        if section["id"] == "recent-conversation" {
            return (end <= boundary && text.get(offset..end).is_some()).then_some((offset, end));
        }
        offset = end.checked_add(2)?;
    }
    None
}

fn turn_header(line: &str) -> bool {
    if !line.starts_with("turn ") {
        return false;
    }
    let mut words = line.split_whitespace();
    let header = words.next() == Some("turn")
        && words.next().is_some()
        && words.next() == Some("status")
        && words.next().is_some_and(|status| {
            matches!(
                status,
                "complete" | "failed" | "cancelled" | "interrupted" | "running"
            )
        });
    header
        && match words.next() {
            None => true,
            Some("completed") => words.next().is_some() && words.next().is_none(),
            Some(_) => false,
        }
}
