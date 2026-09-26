use super::*;
use crate::models::TokenEstimateInput;

pub(crate) fn token_budget_to_chars(tokens: f64) -> usize {
    (tokens.trunc().max(0.0) * 4.0) as usize
}

pub(crate) fn trim_text_to_token_budget(
    snapshot: &ContextBudgetSnapshot<'_>,
    text: &str,
    max_tokens: f64,
    from_start: bool,
    marker: Option<&str>,
) -> ContextResult<String> {
    let trimmed = crate::public_text::trim_js_whitespace(text);
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
    let marker_units = marker.encode_utf16().count();
    let max_units = token_budget_to_chars(max_tokens).saturating_sub(marker_units + 2);
    if max_units == 0 {
        return Ok(marker.to_owned());
    }
    let slice = if from_start {
        crate::public_text::trim_js_whitespace_end(prefix_utf16(trimmed, max_units))
    } else {
        crate::public_text::trim_js_whitespace_start(suffix_utf16(trimmed, max_units))
    };
    Ok(if from_start {
        format!("{slice}\n{marker}")
    } else {
        format!("{marker}\n{slice}")
    })
}

pub(crate) fn prefix_utf16(value: &str, units: usize) -> &str {
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scalar_slices_and_js_one_sided_whitespace_match_source() {
        assert_eq!(prefix_utf16("ab😀cd", 3), "ab");
        assert_eq!(prefix_utf16("ab😀cd", 4), "ab😀");
        assert_eq!(suffix_utf16("ab😀cd", 3), "cd");
        assert_eq!(suffix_utf16("ab😀cd", 4), "😀cd");
        assert_eq!(
            crate::public_text::trim_js_whitespace_start("\u{feff} x\u{85}"),
            "x\u{85}"
        );
        assert_eq!(
            crate::public_text::trim_js_whitespace_end("\u{85}x \u{feff}"),
            "\u{85}x"
        );
    }
}
