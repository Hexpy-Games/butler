//! Read-only feedback quality exclusions for source-backed recall.

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{CognitionError, CognitionResult};

pub(in crate::cognition) struct FeedbackSourceRow<'a> {
    pub source_id: &'a str,
    pub episode_id: &'a str,
    pub revision: &'a str,
    pub content_hash: &'a str,
}

#[derive(Serialize)]
struct FeedbackOwnerRevision<'a> {
    feedback_id: &'a str,
    created_at: &'a str,
    scope: &'a str,
    category: &'a str,
    target_ref: &'a str,
    text: &'a str,
}

struct FeedbackOwner {
    revision: String,
}

/// `read_receipt` is the graph read owner's named memory_state lookup. No raw
/// SQLite connection or durable feedback payload crosses the Cognition facade.
pub(in crate::cognition) fn excluded_source_ids(
    feedback_root: &Path,
    sources: &[FeedbackSourceRow<'_>],
    mut read_receipt: impl FnMut(&str) -> CognitionResult<Option<String>>,
) -> CognitionResult<HashSet<String>> {
    let operations = read_operations(&feedback_root.join("quality-operations.jsonl"))?;
    let owners = read_owners(&feedback_root.join("feedback.md"))?;
    let source_by_id = sources
        .iter()
        .map(|row| (row.source_id, row))
        .collect::<HashMap<_, _>>();
    let mut excluded = HashSet::new();
    for operation in operations {
        if operation["intent"] != "exclude" || operation["status"] == "stale" {
            continue;
        }
        let Some(source_ref) = operation["source_ref"].as_str() else {
            continue;
        };
        let Some(source) = source_by_id.get(source_ref) else {
            continue;
        };
        if operation["episode_id"] != source.episode_id
            || operation["target_revision"] != source.revision
            || operation["source_revision"] != source.revision
            || operation["source_hash"] != source.content_hash
        {
            continue;
        }
        let Some(operation_id) = operation["operation_id"].as_str() else {
            continue;
        };
        let receipt = read_receipt(operation_id)?;
        if receipt
            .as_deref()
            .is_some_and(|raw| receipt_matches(&operation, raw))
        {
            excluded.insert(source_ref.to_owned());
            continue;
        }
        if operation["status"] == "applied" {
            excluded.insert(source_ref.to_owned());
            continue;
        }
        let Some(feedback_id) = operation["feedback_id"].as_str() else {
            continue;
        };
        if operation["status"] == "pending"
            && owners
                .get(feedback_id)
                .is_some_and(|owner| operation["feedback_owner_revision"] == owner.revision)
        {
            excluded.insert(source_ref.to_owned());
        }
    }
    Ok(excluded)
}

fn read_operations(path: &Path) -> CognitionResult<Vec<Value>> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(unavailable(error)),
    };
    Ok(content
        .lines()
        .filter_map(|line| {
            let value: Value = serde_json::from_str(line).ok()?;
            (value["schema"] == "butler.memory-source-quality-operation.v1").then_some(value)
        })
        .collect())
}

fn read_owners(path: &Path) -> CognitionResult<HashMap<String, FeedbackOwner>> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(unavailable(error)),
    };
    let mut owners = HashMap::new();
    for block in content.split("\n## ") {
        let block = block.strip_prefix("## ").unwrap_or(block);
        if block.trim().is_empty() {
            continue;
        }
        let mut lines = block.lines();
        let feedback_id = lines
            .next()
            .and_then(|line| line.split_whitespace().next())
            .unwrap_or("");
        if !feedback_id.starts_with("fb_") {
            continue;
        }
        let mut fields = HashMap::<&str, &str>::new();
        let mut body = Vec::new();
        let mut in_body = false;
        for line in lines {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let field = line
                .strip_prefix("- ")
                .and_then(|line| line.split_once(':'));
            if !in_body
                && let Some((key, value)) = field
                && key.chars().all(|c| c.is_ascii_lowercase() || c == '_')
            {
                fields.insert(key, value.trim_start());
                continue;
            }
            if !line.trim().is_empty() || in_body {
                in_body = true;
                body.push(line);
            }
        }
        let text = crate::public_text::trim_js_whitespace(&body.join("\n")).to_owned();
        let owner = FeedbackOwnerRevision {
            feedback_id,
            created_at: fields.get("created_at").copied().unwrap_or(""),
            scope: fields.get("scope").copied().unwrap_or("global"),
            category: fields.get("category").copied().unwrap_or("unrouted"),
            target_ref: fields.get("target_ref").copied().unwrap_or("unknown"),
            text: &text,
        };
        let bytes = serde_json::to_vec(&owner).map_err(unavailable)?;
        let revision = format!("{:x}", Sha256::digest(bytes));
        owners.insert(feedback_id.to_owned(), FeedbackOwner { revision });
    }
    Ok(owners)
}

fn receipt_matches(operation: &Value, raw: &str) -> bool {
    let Ok(receipt) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    receipt["status"] == "applied"
        && receipt["source_ref"] == operation["source_ref"]
        && receipt["source_hash"] == operation["source_hash"]
        && receipt["episode_id"] == operation["episode_id"]
        && receipt["revision"] == operation["target_revision"]
        && receipt["feedback_owner_revision"] == operation["feedback_owner_revision"]
}

fn unavailable(error: impl std::fmt::Display) -> CognitionError {
    CognitionError::new("memory_source_unavailable", error.to_string())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use serde_json::Value;

    use super::{FeedbackSourceRow, excluded_source_ids};

    #[test]
    fn exclusions_match_unchanged_bun_owner_and_receipt_rules() {
        let fixture: Value =
            serde_json::from_str(include_str!("feedback/fixtures/source-bun.json")).unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let feedback_root =
            std::env::temp_dir().join(format!("butler-feedback-{}-{nonce}", std::process::id()));
        fs::create_dir(&feedback_root).unwrap();
        fs::write(
            feedback_root.join("feedback.md"),
            fixture["owner"].as_str().unwrap(),
        )
        .unwrap();
        let operations = fixture["operations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| serde_json::to_string(row).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(feedback_root.join("quality-operations.jsonl"), operations).unwrap();
        let sources = fixture["sources"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| FeedbackSourceRow {
                source_id: row["source_id"].as_str().unwrap(),
                episode_id: row["episode_id"].as_str().unwrap(),
                revision: row["revision"].as_str().unwrap(),
                content_hash: row["content_hash"].as_str().unwrap(),
            })
            .collect::<Vec<_>>();
        let excluded = excluded_source_ids(&feedback_root, &sources, |id| {
            Ok(fixture["receipts"][id]
                .as_object()
                .map(|_| fixture["receipts"][id].to_string()))
        })
        .unwrap();
        let mut actual = excluded.into_iter().collect::<Vec<_>>();
        actual.sort();
        assert_eq!(serde_json::json!(actual), fixture["expected"]);
        fs::remove_dir_all(feedback_root).unwrap();
    }
}
