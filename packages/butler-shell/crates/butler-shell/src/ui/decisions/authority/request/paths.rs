//! Path helpers of `app/approvalTargets.ts`.
use serde_json::Value;

use super::Target;

pub(super) fn is_absolute_path(path: &str) -> bool {
    let path = path.trim();
    let bytes = path.as_bytes();
    let separator = |b: u8| b == b'/' || b == b'\\';
    path.starts_with('/')
        || path.starts_with("\\\\")
        || (bytes.first() == Some(&b'~') && bytes.get(1).is_none_or(|b| separator(*b)))
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && separator(bytes[2]))
}

/// Trailing separators dropped, keeping at least one character.
pub(super) fn without_trailing_separators(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        path.chars().take(1).collect()
    } else {
        trimmed.to_owned()
    }
}

/// `path` inside `root`, relative to it; `None` when it lies elsewhere.
fn within(path: &str, root: Option<&str>) -> Option<String> {
    let root = root.filter(|r| !r.is_empty())?;
    let rest = path.strip_prefix(root)?;
    if !rest.is_empty() && !rest.starts_with(['/', '\\']) {
        return None;
    }
    if rest.split(['/', '\\']).any(|part| part == "..") {
        return None;
    }
    Some(rest.trim_start_matches(['/', '\\']).to_owned())
}

/// `approvalTargetsFromTransport`: project-relative paths inside the root, exact paths elsewhere.
pub(super) fn targets(value: Option<&Value>) -> (Vec<Target>, impl Fn(&str) -> String + use<>) {
    let raw: Vec<(String, String)> = value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|target| {
            Some((
                target.get("kind")?.as_str()?.to_owned(),
                target.get("path")?.as_str()?.trim().to_owned(),
            ))
        })
        .collect();
    let root = raw
        .iter()
        .find(|(kind, path)| kind == "folder" && is_absolute_path(path))
        .map(|(_, path)| without_trailing_separators(path));
    let relative = move |path: &str| {
        let trimmed = path.trim();
        if !is_absolute_path(trimmed) {
            return if trimmed == "." {
                String::new()
            } else {
                trimmed
                    .strip_prefix("./")
                    .or_else(|| trimmed.strip_prefix(".\\"))
                    .unwrap_or(trimmed)
                    .to_owned()
            };
        }
        within(&without_trailing_separators(trimmed), root.as_deref())
            .unwrap_or_else(|| trimmed.to_owned())
    };
    let targets = raw
        .iter()
        .map(|(kind, path)| {
            if kind != "folder" {
                return Target {
                    kind: kind.clone(),
                    path: relative(path),
                    label: None,
                };
            }
            let label = without_trailing_separators(path);
            let label = if label == "." { String::new() } else { label };
            Target {
                kind: kind.clone(),
                path: String::new(),
                label: (!label.is_empty()).then_some(label),
            }
        })
        .collect();
    (targets, relative)
}
