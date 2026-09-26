use sha2::{Digest, Sha256};

pub(crate) fn normalize_session_id_for_storage(session_id: &str) -> String {
    let trimmed = session_id.trim_matches(is_js_trim_char);
    let normalized: String = trimmed
        .encode_utf16()
        .map(|unit| {
            if unit <= 0x7f
                && ((unit as u8).is_ascii_alphanumeric()
                    || unit == u16::from(b'.')
                    || unit == u16::from(b'_')
                    || unit == u16::from(b'-'))
            {
                char::from_u32(unit as u32).expect("ASCII unit")
            } else {
                '_'
            }
        })
        .collect();

    if normalized.is_empty() {
        return "unknown-session".to_owned();
    }
    if normalized.len() <= 96 {
        return normalized;
    }

    let digest = format!("{:x}", Sha256::digest(trimmed.as_bytes()));
    format!("{}_{}", &normalized[..70], &digest[..24])
}

fn is_js_trim_char(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000d}'
            | ' '
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

#[cfg(test)]
mod tests {
    use super::normalize_session_id_for_storage;
    use sha2::{Digest, Sha256};

    #[test]
    fn normalizes_and_hashes_long_session_ids_like_source() {
        assert_eq!(
            normalize_session_id_for_storage("  alpha/beta  "),
            "alpha_beta"
        );
        assert_eq!(normalize_session_id_for_storage(" 🐈 "), "__");
        assert_eq!(
            normalize_session_id_for_storage("\u{feff}alpha\u{feff}"),
            "alpha"
        );
        assert_eq!(normalize_session_id_for_storage("  "), "unknown-session");

        let input = "x".repeat(100);
        let digest = format!("{:x}", Sha256::digest(input.as_bytes()));
        assert_eq!(
            normalize_session_id_for_storage(&input),
            format!("{}_{}", "x".repeat(70), &digest[..24])
        );
    }
}
