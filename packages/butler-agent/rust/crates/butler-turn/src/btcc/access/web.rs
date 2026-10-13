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
    value.contains(['?', '#'])
        || authority.contains('@')
        || authority.split(['.', ':']).any(data_like_segment)
        || path.split('/').any(data_like_segment)
}

fn data_like_segment(segment: &str) -> bool {
    // Slug separators end a word; slash boundaries are handled by the caller.
    segment.chars().count() >= 40
        || segment
            .split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '+' | '=')))
            .any(|token| token.len() >= 24)
}

/// A query carries outside content when it holds a ≥ 24-char word, an
/// address with a data-like part, or a ≥ 120-char run of text. Search syntax
/// is not text: `OR`/`AND`/`|` and address operators (`site:` and the like)
/// end a run, and their addresses are judged by parts as `web_read` judges a
/// URL. Quotes and parentheses only group words.
pub fn web_search_carries_data(query: &str) -> bool {
    let mut run_start = None;
    for word in query.split_whitespace() {
        let start = offset(query, word);
        match search_term(word) {
            SearchTerm::Text(text) if text.chars().count() >= 24 => return true,
            SearchTerm::Text(_) => {
                run_start.get_or_insert(start);
                continue;
            }
            SearchTerm::Address(address) if address_carries_data(address) => return true,
            SearchTerm::Address(_) | SearchTerm::Connector => {}
        }
        if let Some(run) = run_start.take()
            && long_run(&query[run..start])
        {
            return true;
        }
    }
    run_start.is_some_and(|run| long_run(&query[run..]))
}

enum SearchTerm<'a> {
    Text(&'a str),
    Address(&'a str),
    Connector,
}

/// Operators whose operand is a host or URL part, not words.
const ADDRESS_OPERATORS: [&str; 5] = ["site", "inurl", "allinurl", "related", "link"];

fn search_term(word: &str) -> SearchTerm<'_> {
    let bare = word
        .trim_start_matches(['-', '+'])
        .trim_matches(['(', ')', '"', '\'', ',']);
    if matches!(bare, "OR" | "AND" | "|" | "||") {
        return SearchTerm::Connector;
    }
    if let Some((operator, operand)) = bare.split_once(':')
        && ADDRESS_OPERATORS
            .iter()
            .any(|name| operator.eq_ignore_ascii_case(name))
    {
        let operand = operand.trim_matches(['"', '\'']);
        if !operand.is_empty() {
            return SearchTerm::Address(operand);
        }
    }
    if is_address(bare) {
        SearchTerm::Address(bare)
    } else {
        SearchTerm::Text(bare)
    }
}

/// A bare URL or host path: URL characters with an inner `.` or `/`.
fn is_address(word: &str) -> bool {
    let inner = word
        .char_indices()
        .any(|(at, c)| matches!(c, '.' | '/') && at > 0 && at + 1 < word.len());
    inner
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._~:/?#[]@!$&'()*+,;=%".contains(c))
}

/// An address carries data when a host label, path segment or parameter is
/// data-like; parts are short words, like a query's.
fn address_carries_data(address: &str) -> bool {
    let address = address.split_once("://").map_or(address, |(_, rest)| rest);
    address
        .split(['/', '.', ':', '?', '&', '#', '@'])
        .any(data_like_segment)
}

fn long_run(text: &str) -> bool {
    text.chars().count() >= 120
}

/// The byte offset of `word`, a slice of `query`.
fn offset(query: &str, word: &str) -> usize {
    word.as_ptr() as usize - query.as_ptr() as usize
}
