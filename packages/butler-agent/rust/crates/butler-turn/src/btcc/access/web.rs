//! Pure R5 data-bearing request classification; provenance is owned by the turn.

/// An undiscovered URL can carry data in credentials, query, fragment or long tokens.
pub fn web_read_carries_data(value: &str, discovered: bool) -> bool {
    if discovered {
        return false;
    }
    let Some((_, rest)) = value.split_once("://") else {
        return true;
    };
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    value.contains(['?', '#']) || authority.contains('@') || path.split('/').any(data_like_segment)
}

fn data_like_segment(segment: &str) -> bool {
    // Slug separators end a word; slash boundaries are handled by the caller.
    segment.chars().count() >= 40
        || segment
            .split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '+' | '=')))
            .any(|token| token.len() >= 24)
}

/// A long query or an uninterrupted token can carry outside content.
pub fn web_search_carries_data(query: &str) -> bool {
    query.chars().count() >= 120
        || query
            .split_whitespace()
            .any(|part| part.chars().count() >= 24)
}
