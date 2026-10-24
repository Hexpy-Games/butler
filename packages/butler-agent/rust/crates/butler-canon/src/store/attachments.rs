//! Canon descriptions own attachment references; code and raw HTML are inert.
use crate::store::{Error, Result};
use pulldown_cmark::{Event, Options, Parser, Tag};
use std::collections::BTreeSet;

const MAX_ATTACHMENTS: usize = 20;

pub fn references(description: &str) -> Result<Vec<String>> {
    let mut ids = BTreeSet::new();
    for event in Parser::new_ext(
        description,
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH,
    ) {
        if let Event::Start(Tag::Image { dest_url, .. } | Tag::Link { dest_url, .. }) = event
            && let Some(id) = dest_url.strip_prefix("attachment:")
        {
            if !valid_id(id) {
                return Err(Error::Invalid("invalid attachment id"));
            }
            ids.insert(id.to_owned());
            if ids.len() > MAX_ATTACHMENTS {
                return Err(Error::Invalid("at most 20 attachments per epic"));
            }
        }
    }
    Ok(ids.into_iter().collect())
}

fn valid_id(id: &str) -> bool {
    id.starts_with("file-")
        && id.len() == 41
        && id[5..].bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}
