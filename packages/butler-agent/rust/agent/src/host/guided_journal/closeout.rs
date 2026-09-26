//! Ordinary Turn closeout from the durable journal's ordered result pages.

mod artifacts;
mod changed;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use crate::btcc::{BtccError, JournalCloseout, ToolJournalRepository};

pub(super) async fn collect(
    journal: &Arc<ToolJournalRepository>,
    turn_id: &str,
) -> Result<JournalCloseout, BtccError> {
    let mut artifacts = artifacts::ArtifactCollector::default();
    let mut changed = changed::ChangedCollector::default();
    let mut after = 0;
    loop {
        let page = journal
            .closeout_page(turn_id.to_owned(), after, 8)
            .await
            .map_err(|error| BtccError::new(error.code, error.message))?;
        if page.is_empty() {
            break;
        }
        let count = page.len();
        for row in &page {
            if !super::super::NativeGuidedTools::supports(&row.tool_name) {
                return Err(BtccError::new(
                    "guided_journal_closeout_unbound",
                    "A durable tool result requires its native closeout projection",
                ));
            }
            if row.status == "completed" {
                artifacts.add(row)?;
                changed.add(row)?;
            }
            after = row.rowid;
        }
        // Drops every raw JSON body before the next SQLite actor operation.
        drop(page);
        if count < 8 {
            break;
        }
    }
    Ok(JournalCloseout {
        artifacts: artifacts.finish(),
        changed_files: changed.finish(),
        plan: None,
    })
}

fn invalid(error: crate::json::JsonError) -> BtccError {
    BtccError::new("guided_journal_result_invalid", error.to_string())
}

fn trimmed(value: &str) -> &str {
    value.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}')
}

fn safe_path(value: &str, artifact: bool) -> Option<String> {
    let normalized = trimmed(value).replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || (normalized.len() >= 3
            && normalized.as_bytes()[0].is_ascii_alphabetic()
            && normalized.as_bytes()[1] == b':'
            && normalized.as_bytes()[2] == b'/')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || (artifact && normalized.split('/').next() != Some("artifacts"))
    {
        return None;
    }
    Some(if artifact {
        normalized
    } else {
        crate::json::Utf16Slice::new(&normalized, 0, 1024)
            .utf8_lossy()
            .into_owned()
    })
}
