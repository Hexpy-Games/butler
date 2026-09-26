//! Source UTF-16 slicing for bounded tool-output previews and artifact reads.

use std::borrow::Cow;
use std::fmt::Write;

use crate::json::Utf16Slice;

use super::{ContextResult, OwnedDefaultTokenEstimator};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ExactText {
    Plain(String),
    Units(Vec<u16>),
}

impl ExactText {
    pub(crate) fn from_slice(slice: &Utf16Slice<'_>) -> Self {
        Self::Units(slice.code_units().collect())
    }

    pub(crate) fn len_utf16(&self) -> usize {
        match self {
            Self::Plain(text) => text.encode_utf16().count(),
            Self::Units(units) => units.len(),
        }
    }

    pub(crate) fn append_json_literal(&self, output: &mut String) -> ContextResult<()> {
        match self {
            Self::Plain(text) => crate::json::write_string(text, output).map_err(|error| {
                super::ContextError::new("tool_output_json_error", error.to_string())
            }),
            Self::Units(units) => {
                output.push('"');
                for unit in char::decode_utf16(units.iter().copied()) {
                    match unit {
                        Ok('"') => output.push_str("\\\""),
                        Ok('\\') => output.push_str("\\\\"),
                        Ok('\u{8}') => output.push_str("\\b"),
                        Ok('\u{c}') => output.push_str("\\f"),
                        Ok('\n') => output.push_str("\\n"),
                        Ok('\r') => output.push_str("\\r"),
                        Ok('\t') => output.push_str("\\t"),
                        Ok(character) if character < ' ' => {
                            // Writing to a String cannot fail.
                            let _ = write!(output, "\\u{:04x}", u32::from(character));
                        }
                        Ok(character) => output.push(character),
                        Err(error) => {
                            let _ = write!(output, "\\u{:04x}", error.unpaired_surrogate());
                        }
                    }
                }
                output.push('"');
                Ok(())
            }
        }
    }

    pub(crate) fn utf8_lossy(&self) -> Cow<'_, str> {
        match self {
            Self::Plain(text) => Cow::Borrowed(text),
            Self::Units(units) => Cow::Owned(String::from_utf16_lossy(units)),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ToolArtifactTextSlice {
    pub text: ExactText,
    pub start_line: usize,
    pub returned_lines: usize,
    pub total_lines: usize,
    pub estimated_tokens: f64,
    pub truncated_by_lines: bool,
    pub truncated_by_tokens: bool,
    pub start_char: usize,
    pub next_offset_chars: Option<usize>,
    pub total_chars: usize,
    pub applied_max_tokens: usize,
    pub search: Option<ToolArtifactSearch>,
}

#[derive(Clone, Debug)]
pub(crate) struct ToolArtifactSearch {
    pub query: String,
    pub found: bool,
    pub match_char: Option<usize>,
}

#[derive(Clone, Copy)]
pub(crate) struct SliceInput<'a> {
    pub text: &'a str,
    pub offset_lines: usize,
    pub offset_chars: Option<usize>,
    pub search: Option<&'a str>,
    pub limit_lines: usize,
    pub max_tokens: usize,
}

pub(crate) fn estimate_slice(
    estimator: &OwnedDefaultTokenEstimator,
    slice: &Utf16Slice<'_>,
) -> ContextResult<f64> {
    match estimator.provider_id() {
        "openai" => Ok(estimator.estimate(&slice.utf8_lossy())?.tokens),
        "google" => Ok((slice.len_utf16() as f64 / 4.0).ceil()),
        _ => Ok((slice.len_utf16() as f64 / 3.8).ceil()),
    }
}

pub(crate) fn slice_tool_artifact_text(
    estimator: &OwnedDefaultTokenEstimator,
    input: SliceInput<'_>,
) -> ContextResult<ToolArtifactTextSlice> {
    let total = input.text.encode_utf16().count();
    let mut start = input.offset_chars.unwrap_or(0).min(total);
    if input.offset_chars.is_none() {
        let mut after = 0;
        for _ in 0..input.offset_lines {
            if after >= input.text.len() {
                break;
            }
            after = match input.text[after..].find('\n') {
                Some(index) => after + index + 1,
                None => input.text.len(),
            };
        }
        start = input.text[..after].encode_utf16().count();
    }
    let mut match_char = None;
    if let Some(query) = input.search.filter(|query| !query.is_empty()) {
        let byte_start = utf16_byte_ceil(input.text, start);
        match_char = input.text[byte_start..]
            .find(query)
            .map(|index| input.text[..byte_start + index].encode_utf16().count());
        start = match_char.unwrap_or(total);
    }

    let mut line_end_byte = utf16_byte_ceil(input.text, start);
    for _ in 0..input.limit_lines {
        if line_end_byte >= input.text.len() {
            break;
        }
        line_end_byte = match input.text[line_end_byte..].find('\n') {
            Some(index) => line_end_byte + index + 1,
            None => input.text.len(),
        };
    }
    let line_end = input.text[..line_end_byte].encode_utf16().count();
    let mut low = start;
    let mut high = line_end;
    while low < high {
        let middle = low + (high - low).div_ceil(2);
        let candidate = Utf16Slice::new(input.text, start, middle);
        if estimate_slice(estimator, &candidate)? <= input.max_tokens as f64 {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    let exact = Utf16Slice::new(input.text, start, low);
    let text = ExactText::from_slice(&exact);
    let newline_count = exact
        .code_units()
        .filter(|unit| *unit == u16::from(b'\n'))
        .count();
    let last_newline = exact.code_units().last() == Some(u16::from(b'\n'));
    Ok(ToolArtifactTextSlice {
        text,
        start_line: input.text[..utf16_byte_ceil(input.text, start)]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count(),
        returned_lines: if low == start {
            0
        } else {
            newline_count + usize::from(!last_newline)
        },
        total_lines: input.text.bytes().filter(|byte| *byte == b'\n').count() + 1,
        estimated_tokens: estimate_slice(estimator, &exact)?,
        truncated_by_lines: line_end < total,
        truncated_by_tokens: low < line_end,
        start_char: start,
        next_offset_chars: (low < total).then_some(low),
        total_chars: total,
        applied_max_tokens: input.max_tokens,
        search: input
            .search
            .filter(|query| !query.is_empty())
            .map(|query| ToolArtifactSearch {
                query: query.to_owned(),
                found: match_char.is_some(),
                match_char,
            }),
    })
}

fn utf16_byte_ceil(text: &str, target: usize) -> usize {
    let mut units = 0;
    for (byte, character) in text.char_indices() {
        if units >= target {
            return byte;
        }
        units += character.len_utf16();
    }
    text.len()
}
