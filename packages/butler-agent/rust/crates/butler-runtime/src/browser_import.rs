//! Import from other browsers: bookmark files (Chromium JSON, Firefox
//! `places.sqlite`, Safari property list, HTML export) and the browsers'
//! own password CSV exports. Parsing only; callers own storage.
mod bookmarks;
mod passwords;
pub use bookmarks::{chromium, firefox, netscape_html, safari};
pub use passwords::{PasswordRow, parse_password_csv};

/// Most bookmarks one import accepts.
pub const MAX_BOOKMARKS: usize = 20_000;
/// Largest bookmark file read.
pub const MAX_BOOKMARK_BYTES: u64 = 64 * 1024 * 1024;
/// Largest password CSV read.
pub const MAX_CSV_BYTES: u64 = 16 * 1024 * 1024;

/// One bookmark with its folder path (`Bar / Work`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bookmark {
    pub title: String,
    pub url: String,
    pub folder: String,
}

/// Why an import source could not be read.
#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("the file could not be read")]
    Unreadable,
    #[error("the file is not in the expected format")]
    Format,
    #[error("the file is too large")]
    TooLarge,
}

/// Web bookmarks only, normalized, de-duplicated by URL (first kept) and capped.
pub fn finish(items: Vec<Bookmark>) -> Vec<Bookmark> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for mut item in items {
        let Ok(url) = url::Url::parse(item.url.trim()) else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            continue;
        }
        item.url = url.to_string();
        if item.url.len() > 4096 || !seen.insert(item.url.clone()) {
            continue;
        }
        item.title = clip(item.title.trim(), 2000);
        if item.title.is_empty() {
            item.title = url.host_str().unwrap_or("").to_owned();
        }
        item.folder = clip(item.folder.trim(), 200);
        out.push(item);
        if out.len() == MAX_BOOKMARKS {
            break;
        }
    }
    out
}

fn clip(value: &str, max: usize) -> String {
    let mut end = value.len().min(max);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.get(..end).unwrap_or("").to_owned()
}

/// The Library item for a bookmark; the id is the URL's hash, so a repeated
/// import never duplicates an item.
pub fn library_item(bookmark: &Bookmark, captured_at: &str) -> serde_json::Value {
    use sha2::{Digest, Sha256};
    let mut item = serde_json::json!({
        "id": format!("bookmark-{:x}", Sha256::digest(bookmark.url.as_bytes())),
        "kind": "bookmark", "title": bookmark.title, "url": bookmark.url, "capturedAt": captured_at,
    });
    if !bookmark.folder.is_empty() {
        item["folder"] = serde_json::json!(bookmark.folder);
    }
    item
}

pub(crate) fn join_folder(parent: &str, name: &str) -> String {
    match (parent.is_empty(), name.trim().is_empty()) {
        (true, _) => name.trim().to_owned(),
        (false, true) => parent.to_owned(),
        (false, false) => format!("{parent} / {}", name.trim()),
    }
}
