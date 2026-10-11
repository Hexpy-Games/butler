//! Bookmark formats. Each returns raw bookmarks with folder paths; `finish`
//! normalizes and de-duplicates them.
use super::{Bookmark, ImportError, join_folder};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

/// Chromium `Bookmarks` JSON (Chrome, Edge, Brave, Whale).
pub fn chromium(bytes: &[u8]) -> Result<Vec<Bookmark>, ImportError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ImportError::Format)?;
    let roots = value["roots"].as_object().ok_or(ImportError::Format)?;
    let mut out = Vec::new();
    for key in ["bookmark_bar", "other", "synced"] {
        if let Some(root) = roots.get(key) {
            let name = root["name"].as_str().unwrap_or(key);
            chromium_node(root, name, &mut out, 0);
        }
    }
    Ok(out)
}

fn chromium_node(node: &Value, folder: &str, out: &mut Vec<Bookmark>, depth: usize) {
    if depth > 64 {
        return;
    }
    for child in node["children"].as_array().into_iter().flatten() {
        match child["type"].as_str() {
            Some("url") => out.push(Bookmark {
                title: child["name"].as_str().unwrap_or("").to_owned(),
                url: child["url"].as_str().unwrap_or("").to_owned(),
                folder: folder.to_owned(),
            }),
            Some("folder") => {
                let path = join_folder(folder, child["name"].as_str().unwrap_or(""));
                chromium_node(child, &path, out, depth + 1);
            }
            _ => {}
        }
    }
}

/// Firefox `places.sqlite`, read from a private copy (the browser may hold a lock).
pub fn firefox(places: &Path, scratch: &Path) -> Result<Vec<Bookmark>, ImportError> {
    std::fs::create_dir_all(scratch).map_err(|_| ImportError::Unreadable)?;
    let copy = scratch.join("places.sqlite");
    std::fs::copy(places, &copy).map_err(|_| ImportError::Unreadable)?;
    let wal = places.with_extension("sqlite-wal");
    if wal.is_file() {
        std::fs::copy(&wal, scratch.join("places.sqlite-wal"))
            .map_err(|_| ImportError::Unreadable)?;
    }
    let result = read_places(&copy);
    let _ = std::fs::remove_dir_all(scratch);
    result
}

struct Folder {
    parent: i64,
    title: String,
    guid: String,
}

fn read_places(path: &Path) -> Result<Vec<Bookmark>, ImportError> {
    let db = rusqlite::Connection::open(path).map_err(|_| ImportError::Unreadable)?;
    let mut folders = HashMap::new();
    let mut statement = db
        .prepare(
            "SELECT id,parent,COALESCE(title,''),COALESCE(guid,'') FROM moz_bookmarks WHERE type=2",
        )
        .map_err(|_| ImportError::Format)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                Folder {
                    parent: row.get(1)?,
                    title: row.get(2)?,
                    guid: row.get(3)?,
                },
            ))
        })
        .map_err(|_| ImportError::Format)?;
    for row in rows {
        let (id, folder) = row.map_err(|_| ImportError::Format)?;
        folders.insert(id, folder);
    }
    let mut statement = db
        .prepare(
            "SELECT b.parent,COALESCE(b.title,''),p.url FROM moz_bookmarks b JOIN moz_places p ON p.id=b.fk \
             WHERE b.type=1 ORDER BY b.parent,b.position LIMIT 100000",
        )
        .map_err(|_| ImportError::Format)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|_| ImportError::Format)?;
    let mut out = Vec::new();
    for row in rows {
        let (parent, title, url) = row.map_err(|_| ImportError::Format)?;
        if let Some(folder) = folder_path(&folders, parent) {
            out.push(Bookmark { title, url, folder });
        }
    }
    Ok(out)
}

/// The folder path, or `None` inside tags (Firefox stores tags as folders).
fn folder_path(folders: &HashMap<i64, Folder>, mut id: i64) -> Option<String> {
    let mut names = Vec::new();
    for _ in 0..64 {
        let Some(folder) = folders.get(&id) else {
            break;
        };
        let name = match folder.guid.as_str() {
            "root________" => break,
            "tags________" => return None,
            "menu________" => "Bookmarks Menu",
            "toolbar_____" => "Bookmarks Toolbar",
            "unfiled_____" => "Other Bookmarks",
            "mobile______" => "Mobile Bookmarks",
            _ => folder.title.as_str(),
        };
        names.push(name.to_owned());
        id = folder.parent;
    }
    Some(
        names
            .iter()
            .rev()
            .fold(String::new(), |path, name| join_folder(&path, name)),
    )
}

/// Safari's `Bookmarks.plist` as XML (see `butler_platform::browser_profiles`).
pub fn safari(xml: &str) -> Result<Vec<Bookmark>, ImportError> {
    // Property lists carry the Apple DOCTYPE; external entities are never fetched.
    let options = roxmltree::ParsingOptions {
        allow_dtd: true,
        ..Default::default()
    };
    let document =
        roxmltree::Document::parse_with_options(xml, options).map_err(|_| ImportError::Format)?;
    let root = document
        .root_element()
        .children()
        .find(|node| node.has_tag_name("dict"))
        .ok_or(ImportError::Format)?;
    let mut out = Vec::new();
    safari_node(root, "", &mut out, 0);
    Ok(out)
}

fn plist_value<'a, 'i>(
    dict: roxmltree::Node<'a, 'i>,
    key: &str,
) -> Option<roxmltree::Node<'a, 'i>> {
    let mut children = dict.children().filter(roxmltree::Node::is_element);
    while let Some(node) = children.next() {
        let value = children.next()?;
        if node.has_tag_name("key") && node.text() == Some(key) {
            return Some(value);
        }
    }
    None
}

fn safari_node(dict: roxmltree::Node<'_, '_>, folder: &str, out: &mut Vec<Bookmark>, depth: usize) {
    if depth > 64 {
        return;
    }
    let text = |key: &str| {
        plist_value(dict, key)
            .and_then(|node| node.text())
            .unwrap_or("")
            .to_owned()
    };
    match text("WebBookmarkType").as_str() {
        "WebBookmarkTypeLeaf" => out.push(Bookmark {
            title: plist_value(dict, "URIDictionary")
                .and_then(|uri| plist_value(uri, "title"))
                .and_then(|node| node.text())
                .unwrap_or("")
                .to_owned(),
            url: text("URLString"),
            folder: folder.to_owned(),
        }),
        "WebBookmarkTypeList" => {
            let title = text("Title");
            if title == "com.apple.ReadingList" {
                return;
            }
            let name = match title.as_str() {
                "BookmarksBar" => "Favorites",
                "BookmarksMenu" => "Bookmarks Menu",
                other => other,
            };
            let path = if depth == 0 {
                String::new()
            } else {
                join_folder(folder, name)
            };
            for child in plist_value(dict, "Children")
                .into_iter()
                .flat_map(|array| array.children().filter(|node| node.has_tag_name("dict")))
            {
                safari_node(child, &path, out, depth + 1);
            }
        }
        _ => {}
    }
}

/// The Netscape bookmark HTML every browser exports.
pub fn netscape_html(html: &str) -> Result<Vec<Bookmark>, ImportError> {
    if !html.to_ascii_lowercase().contains("<dl") {
        return Err(ImportError::Format);
    }
    let mut out = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut pending: Option<String> = None;
    let mut rest = html;
    while let Some(start) = rest.find('<') {
        let tail = rest.get(start..).unwrap_or("");
        let end = tail.find('>').unwrap_or(tail.len());
        let tag = tail.get(1..end).unwrap_or("");
        let lower = tag.to_ascii_lowercase();
        let after = tail.get(end + 1..).unwrap_or("");
        let folder = stack.last().cloned().unwrap_or_default();
        if lower.starts_with("h3") {
            pending = Some(decode(
                after
                    .get(..after.find('<').unwrap_or(after.len()))
                    .unwrap_or(""),
            ));
        } else if lower.starts_with("dl") {
            let name = pending.take().unwrap_or_default();
            stack.push(if stack.is_empty() {
                name.trim().to_owned()
            } else {
                join_folder(&folder, &name)
            });
        } else if lower.starts_with("/dl") {
            stack.pop();
        } else if lower.starts_with("a ") {
            let title = decode(
                after
                    .get(..after.find('<').unwrap_or(after.len()))
                    .unwrap_or(""),
            );
            if let Some(url) = attribute(tag, "href") {
                out.push(Bookmark {
                    title,
                    url: decode(&url),
                    folder,
                });
            }
        }
        rest = tail.get(end.saturating_add(1)..).unwrap_or("");
    }
    Ok(out)
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let at = lower.find(&format!("{name}="))? + name.len() + 1;
    let value = tag.get(at..)?;
    let quote = value.chars().next()?;
    if quote == '"' || quote == '\'' {
        let inner = value.get(1..)?;
        inner
            .find(quote)
            .and_then(|end| inner.get(..end))
            .map(str::to_owned)
    } else {
        Some(value.split_whitespace().next()?.to_owned())
    }
}

fn decode(text: &str) -> String {
    text.trim()
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&amp;", "&")
}
