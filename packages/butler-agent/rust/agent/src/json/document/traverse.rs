//! Borrowed JSON traversal for a bounded provider preview. Child values retain
//! original encoded bytes, including unpaired UTF-16 escape units.

use std::collections::VecDeque;

use serde::Deserializer;
use serde::de::{Error, MapAccess, SeqAccess, Visitor};
use serde_json::value::RawValue;

use crate::json::JsonError;

pub(crate) fn visit_raw_object<'a>(
    encoded: &'a str,
    field: impl FnMut(&'a str, &'a str) -> Result<(), JsonError>,
) -> Result<(), JsonError> {
    struct Fields<F>(F);
    impl<'de, F> Visitor<'de> for Fields<F>
    where
        F: FnMut(&'de str, &'de str) -> Result<(), JsonError>,
    {
        type Value = ();
        fn expecting(&self, fmt: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            fmt.write_str("a JSON object")
        }
        fn visit_map<M: MapAccess<'de>>(mut self, mut map: M) -> Result<(), M::Error> {
            while let Some((key, value)) = map.next_entry::<&RawValue, &RawValue>()? {
                (self.0)(key.get(), value.get()).map_err(M::Error::custom)?;
            }
            Ok(())
        }
    }
    serde_json::Deserializer::from_str(encoded)
        .deserialize_map(Fields(field))
        .map_err(|error| JsonError::new(error.to_string()))
}

pub(crate) fn visit_raw_array<'a>(
    encoded: &'a str,
    item: impl FnMut(&'a str) -> Result<(), JsonError>,
) -> Result<(), JsonError> {
    struct Items<F>(F);
    impl<'de, F> Visitor<'de> for Items<F>
    where
        F: FnMut(&'de str) -> Result<(), JsonError>,
    {
        type Value = ();
        fn expecting(&self, fmt: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            fmt.write_str("a JSON array")
        }
        fn visit_seq<S: SeqAccess<'de>>(mut self, mut seq: S) -> Result<(), S::Error> {
            while let Some(value) = seq.next_element::<&RawValue>()? {
                (self.0)(value.get()).map_err(S::Error::custom)?;
            }
            Ok(())
        }
    }
    serde_json::Deserializer::from_str(encoded)
        .deserialize_seq(Items(item))
        .map_err(|error| JsonError::new(error.to_string()))
}

const LINE_MARKER: &str = "\n[remaining lines omitted]";
const CONTENT_MARKER: &str = "\n[content omitted; continue from the provided cursor or artifact]\n";

/// Source middle-elision over decoded UTF-16 units without a full string copy.
pub(crate) fn bound_raw_string(raw: &str, max_chars: usize) -> Result<String, JsonError> {
    let mut head = Vec::with_capacity(max_chars);
    let mut tail = VecDeque::with_capacity(max_chars);
    let mut total = 0usize;
    let mut lines = 0usize;
    let mut stopped = false;
    let mut push = |unit| {
        total += 1;
        if head.len() < max_chars {
            head.push(unit);
        }
        if tail.len() == max_chars {
            tail.pop_front();
        }
        tail.push_back(unit);
    };
    for unit in RawUnits::new(raw) {
        if unit == 10 {
            lines += 1;
            if lines == 2_000 {
                stopped = true;
                break;
            }
        }
        push(unit);
    }
    if stopped {
        for unit in LINE_MARKER.encode_utf16() {
            push(unit);
        }
    }
    let mut output = String::from("\"");
    if total <= max_chars {
        append_units(&head, &mut output);
    } else {
        let side = ((max_chars.saturating_sub(CONTENT_MARKER.len())) / 2).max(1);
        append_units(&head[..side.min(head.len())], &mut output);
        append_units(
            &CONTENT_MARKER.encode_utf16().collect::<Vec<_>>(),
            &mut output,
        );
        let tail = tail.make_contiguous();
        append_units(&tail[tail.len().saturating_sub(side)..], &mut output);
    }
    output.push('"');
    Ok(output)
}

pub(crate) fn raw_string_contains_any(raw: &str, markers: &[&str]) -> bool {
    let patterns = markers
        .iter()
        .map(|marker| marker.encode_utf16().collect::<Vec<_>>())
        .collect::<Vec<_>>();
    let width = patterns.iter().map(Vec::len).max().unwrap_or(0);
    if width == 0 {
        return false;
    }
    let mut recent = VecDeque::with_capacity(width);
    for unit in RawUnits::new(raw) {
        if recent.len() == width {
            recent.pop_front();
        }
        recent.push_back(unit);
        if patterns.iter().any(|pattern| {
            recent.len() >= pattern.len()
                && recent
                    .iter()
                    .rev()
                    .take(pattern.len())
                    .copied()
                    .eq(pattern.iter().rev().copied())
        }) {
            return true;
        }
    }
    false
}

/// Iterate a validated JSON string literal without allocating a scalar string.
/// Callers pass a string field borrowed from a validated `JsonDocument`.
pub(crate) fn raw_string_units(raw: &str) -> impl Iterator<Item = u16> + '_ {
    RawUnits::new(raw)
}

struct RawUnits<'a> {
    raw: &'a str,
    at: usize,
    pending: Option<u16>,
}
impl<'a> RawUnits<'a> {
    fn new(raw: &'a str) -> Self {
        Self {
            raw,
            at: 1,
            pending: None,
        }
    }
}
impl Iterator for RawUnits<'_> {
    type Item = u16;
    fn next(&mut self) -> Option<u16> {
        if let Some(unit) = self.pending.take() {
            return Some(unit);
        }
        if self.at >= self.raw.len().saturating_sub(1) {
            return None;
        }
        let bytes = self.raw.as_bytes();
        if bytes[self.at] == b'\\' {
            let escaped = bytes[self.at + 1];
            self.at += 2;
            return Some(match escaped {
                b'u' => {
                    let code = u16::from_str_radix(&self.raw[self.at..self.at + 4], 16).ok()?;
                    self.at += 4;
                    code
                }
                b'n' => 10,
                b'r' => 13,
                b't' => 9,
                b'b' => 8,
                b'f' => 12,
                other => other as u16,
            });
        }
        let character = self.raw[self.at..].chars().next()?;
        self.at += character.len_utf8();
        let mut units = [0u16; 2];
        let written = character.encode_utf16(&mut units);
        if written.len() == 2 {
            self.pending = Some(units[1]);
        }
        Some(units[0])
    }
}

fn append_units(units: &[u16], output: &mut String) {
    let mut at = 0;
    while at < units.len() {
        let unit = units[at];
        if (0xd800..=0xdbff).contains(&unit)
            && at + 1 < units.len()
            && (0xdc00..=0xdfff).contains(&units[at + 1])
        {
            let scalar =
                0x10000 + (((unit as u32 - 0xd800) << 10) | (units[at + 1] as u32 - 0xdc00));
            output.push(char::from_u32(scalar).unwrap_or(char::REPLACEMENT_CHARACTER));
            at += 2;
            continue;
        }
        match unit {
            0x22 => output.push_str("\\\""),
            0x5c => output.push_str("\\\\"),
            8 => output.push_str("\\b"),
            9 => output.push_str("\\t"),
            10 => output.push_str("\\n"),
            12 => output.push_str("\\f"),
            13 => output.push_str("\\r"),
            0..=31 | 0xd800..=0xdfff => output.push_str(&format!("\\u{unit:04x}")),
            _ => {
                output.push(char::from_u32(u32::from(unit)).unwrap_or(char::REPLACEMENT_CHARACTER))
            }
        }
        at += 1;
    }
}
