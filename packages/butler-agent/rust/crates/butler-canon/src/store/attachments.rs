//! Canon descriptions own attachment references; code and raw HTML are inert.
use crate::store::{Error, Result};
use pulldown_cmark::{Event, Options, Parser, Tag};
use std::collections::BTreeSet;

const MAX_ATTACHMENTS: usize = 20;

pub fn references(description: &str) -> Result<Vec<String>> {
    let ids = references_lenient(description);
    if ids.iter().any(|id| !valid_id(id)) {
        return Err(Error::Invalid("invalid attachment id"));
    }
    if ids.len() > MAX_ATTACHMENTS {
        return Err(Error::Invalid("at most 20 attachments per epic"));
    }
    Ok(ids)
}

/// Historical descriptions must never block unrelated label or tag events.
/// Format and count validation belong only to description writes.
pub fn references_lenient(description: &str) -> Vec<String> {
    let mut ids = BTreeSet::new();
    for event in Parser::new_ext(
        description,
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH,
    ) {
        if let Event::Start(Tag::Image { dest_url, .. } | Tag::Link { dest_url, .. }) = event
            && dest_url
                .get(..11)
                .is_some_and(|scheme| scheme.eq_ignore_ascii_case("attachment:"))
            && let Some(id) = dest_url.get(11..)
        {
            ids.insert(id.to_owned());
        }
    }
    ids.into_iter().collect()
}

fn valid_id(id: &str) -> bool {
    id.starts_with("file-")
        && id.len() == 41
        && id[5..].bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}
