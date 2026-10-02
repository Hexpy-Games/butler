use super::*;
use butler_models::models::TokenEstimateInput;

pub(crate) fn trim_text_to_token_budget(
    snapshot: &ContextBudgetSnapshot<'_>,
    text: &str,
    max_tokens: f64,
    from_start: bool,
    marker: Option<&str>,
) -> ContextResult<String> {
    let trimmed = butler_core::public_text::trim_js_whitespace(text);
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if snapshot
        .estimate(TokenEstimateInput::Text(trimmed), None)?
        .tokens
        <= max_tokens
    {
        return Ok(trimmed.to_owned());
    }
    let marker = marker.unwrap_or("[...trimmed for context budget...]");
    if snapshot
        .estimate(TokenEstimateInput::Text(marker), None)?
        .tokens
        > max_tokens
    {
        return Ok(String::new());
    }
    let mut low = 0;
    let mut high = trimmed.encode_utf16().count();
    let mut result = marker.to_owned();
    while low < high {
        let middle = low + (high - low).div_ceil(2);
        let slice = if from_start {
            prefix_utf16(trimmed, middle)
        } else {
            suffix_utf16(trimmed, middle)
        };
        let candidate = if from_start {
            format!("{slice}\n{marker}")
        } else {
            format!("{marker}\n{slice}")
        };
        if snapshot
            .estimate(TokenEstimateInput::Text(&candidate), None)?
            .tokens
            <= max_tokens
        {
            result = candidate;
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    Ok(result)
}

pub fn prefix_utf16(value: &str, units: usize) -> &str {
    let mut end = 0;
    for (index, character) in value.char_indices() {
        let next = end + character.len_utf16();
        if next > units {
            return &value[..index];
        }
        end = next;
    }
    value
}

pub(crate) fn suffix_utf16(value: &str, units: usize) -> &str {
    let mut used = 0;
    for (index, character) in value.char_indices().rev() {
        let next = used + character.len_utf16();
        if next > units {
            return &value[index + character.len_utf8()..];
        }
        used = next;
    }
    value
}
