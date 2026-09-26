//! Source-compatible provider deadline, retry, and prompt-cache normalization.

use std::time::Duration;

use crate::models::PromptCacheRetention;

const DEFAULT_TOTAL_MS: f64 = 600_000.0;
const DEFAULT_IDLE_MS: f64 = 120_000.0;
const DEFAULT_RETRY_BASE_MS: f64 = 750.0;
const BUN_TIMER_MAX_MS: f64 = i32::MAX as f64;

pub(super) fn total(value: Option<&str>) -> Duration {
    duration(positive_integer_ms(value, DEFAULT_TOTAL_MS))
}
pub(super) fn idle(value: Option<&str>) -> Duration {
    duration(positive_integer_ms(value, DEFAULT_IDLE_MS))
}
pub(super) fn retry_base(value: Option<&str>) -> f64 {
    value
        .map(crate::json::number_from_string)
        .filter(|value| value.is_finite())
        .map(|value| value.max(0.0))
        .unwrap_or(DEFAULT_RETRY_BASE_MS)
}
pub(super) fn sanitize_cache_segment(value: &str) -> String {
    let mut output = String::new();
    let mut dash = false;
    for character in crate::public_text::trim_js_whitespace(value).chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-') {
            output.push(character);
            dash = false;
        } else if !dash {
            output.push('-');
            dash = true;
        }
    }
    output.trim_matches(['-', ':']).to_owned()
}
pub(super) fn cache_retention(value: &str) -> Option<PromptCacheRetention> {
    match value {
        "in_memory" => Some(PromptCacheRetention::InMemory),
        "24h" => Some(PromptCacheRetention::Hours24),
        _ => None,
    }
}
pub(super) fn cache_prefix(data: &std::path::Path) -> String {
    use sha2::{Digest, Sha256};
    let data = data.canonicalize().unwrap_or_else(|_| data.to_path_buf());
    let stable = format!("butler|{}", data.display());
    let digest = Sha256::digest(stable.as_bytes());
    let prefix = digest
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("butler:{prefix}")
}

fn positive_integer_ms(value: Option<&str>, fallback: f64) -> f64 {
    let parsed = value.map(crate::json::number_from_string);
    if parsed.is_some_and(|value| value.fract() == 0.0 && value > 0.0) {
        parsed.unwrap()
    } else {
        fallback
    }
}
fn duration(milliseconds: f64) -> Duration {
    // Bun 1.3.11 converts timer delays above signed 32-bit range to 1 ms.
    let milliseconds = if milliseconds > BUN_TIMER_MAX_MS {
        1.0
    } else {
        milliseconds
    };
    Duration::from_secs_f64(milliseconds / 1000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_grammar_preserves_deadline_and_retry_policy() {
        assert_eq!(total(Some("0b1000")), Duration::from_millis(8));
        assert_eq!(idle(Some("0o10")), Duration::from_millis(8));
        for invalid in ["+0x10", "-0x10", "inf", "Infinity", "0.5", ""] {
            assert_eq!(total(Some(invalid)), Duration::from_millis(600_000));
        }
        assert_eq!(total(Some("2147483648")), Duration::from_millis(1));
        assert_eq!(retry_base(Some("0b1000")), 8.0);
        assert_eq!(retry_base(Some("-0x10")), 750.0);
        assert_eq!(retry_base(Some("-2")), 0.0);
        assert_eq!(retry_base(Some("")), 0.0);
        assert_eq!(retry_base(None), 750.0);
    }
}
