//! Ordinary Turn closeout from the durable journal's ordered result pages.

mod artifacts;
mod changed;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use butler_turn::btcc::{BtccError, JournalCloseout, ToolJournalRepository};

pub(super) async fn collect(
    journal: &Arc<ToolJournalRepository>,
    turn_id: &str,
    workspace: &str,
) -> Result<JournalCloseout, BtccError> {
    let mut artifacts = artifacts::ArtifactCollector::default();
    let mut changed = changed::ChangedCollector::default();
    let mut after = 0;
    loop {
        let page = journal
            .closeout_page(turn_id.to_owned(), after, 8)
            .await
            .map_err(BtccError::from)?;
        if page.is_empty() {
            break;
        }
        let count = page.len();
        for row in &page {
            if !crate::host::GuidedTools::supports(&row.tool_name) {
                return Err(BtccError::relayed(
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
    let changed_files = changed.finish();
    Ok(JournalCloseout {
        artifacts: artifacts::with_changed_files(artifacts.finish(), &changed_files, workspace),
        changed_files,
    })
}

fn invalid(error: butler_core::json::JsonError) -> BtccError {
    BtccError::relayed("guided_journal_result_invalid", error.to_string()).with_source(error)
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
        butler_core::json::Utf16Slice::new(&normalized, 0, 1024)
            .utf8_lossy()
            .into_owned()
    })
}

/// Child results precede local edits; the latest file record wins by path.
pub(super) fn merge_files(mut child: JournalCloseout, own: JournalCloseout) -> JournalCloseout {
    let mut merged = JournalCloseout {
        artifacts: Vec::new(),
        changed_files: Vec::new(),
    };
    child.changed_files.extend(own.changed_files);
    child.artifacts.extend(own.artifacts);
    for file in child.changed_files {
        if let Some(previous) = merged
            .changed_files
            .iter_mut()
            .find(|item| item.path == file.path)
        {
            *previous = file;
        } else {
            merged.changed_files.push(file);
        }
    }
    for artifact in child.artifacts {
        if let Some(previous) = merged
            .artifacts
            .iter_mut()
            .find(|item| item.safe_path_label == artifact.safe_path_label)
        {
            *previous = artifact;
        } else {
            merged.artifacts.push(artifact);
        }
    }
    merged
}
