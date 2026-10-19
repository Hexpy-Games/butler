//! Ordinary Turn closeout from the durable journal's ordered result pages.

pub(super) mod artifacts;
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
    let mut answer_blocks = Vec::new();
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
                if row.tool_name == "answer_blocks"
                    && row
                        .result
                        .as_ref()
                        .is_some_and(|r| r.field("ok").ok().flatten() == Some("true"))
                {
                    let mut spec: serde_json::Value = row.arguments.read().map_err(invalid)?;
                    butler_runtime::capabilities::answer_blocks::normalize(&mut spec);
                    butler_runtime::capabilities::answer_blocks::accept(
                        &mut answer_blocks,
                        &row.call_id,
                        spec,
                    );
                }
            }
            after = row.rowid;
        }
        // Drops every raw JSON body before the next SQLite actor operation.
        drop(page);
        if count < 8 {
            break;
        }
    }
    let changed_files = changed
        .finish()
        .into_iter()
        .map(|mut file| {
            if let Some(path) = artifacts::source_label(&file.path, workspace) {
                file.path = path;
            }
            file
        })
        .collect::<Vec<_>>();
    let outputs = std::mem::take(&mut artifacts.outputs);
    let artifacts = artifacts::with_changed_files(artifacts.finish(), &changed_files, workspace);
    for artifact in &artifacts {
        if let Some(path) = &artifact.staged_path {
            butler_platform::secure_fs::handoff_staged(std::path::Path::new(path));
        }
    }
    Ok(JournalCloseout {
        outputs,
        artifacts,
        changed_files,
        answer_blocks,
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
    if !artifact && std::path::Path::new(&normalized).is_absolute() {
        return Some(normalized);
    }
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || (artifact && normalized.split('/').next() != Some("artifacts"))
    {
        return None;
    }
    Some(normalized)
}

/// An answer that pictures an item in its blocks shows that picture once: a
/// capture of the same item's page (its own or a delegated result's) is not
/// attached beside it. Captures of other pages and every other file stay.
pub(super) fn without_pictured(mut closeout: JournalCloseout) -> JournalCloseout {
    let pictured =
        butler_runtime::capabilities::answer_blocks::pictured_sources(&closeout.answer_blocks);
    if pictured.is_empty() {
        return closeout;
    }
    closeout.artifacts.retain(|artifact| {
        artifact.kind != butler_turn::btcc::ArtifactKind::Image
            || artifact
                .source_url
                .as_deref()
                .and_then(butler_runtime::capabilities::answer_blocks::page_identity)
                .is_none_or(|page| !pictured.contains(&page))
    });
    closeout
}

/// Child results precede local edits; the latest file record wins by path.
pub(super) fn merge_files(mut child: JournalCloseout, own: JournalCloseout) -> JournalCloseout {
    let mut merged = JournalCloseout {
        artifacts: Vec::new(),
        changed_files: Vec::new(),
        answer_blocks: own.answer_blocks,
        outputs: child.outputs,
    };
    for output in own.outputs {
        if !merged.outputs.contains(&output) {
            merged.outputs.push(output);
        }
    }
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
    for mut artifact in child.artifacts {
        if let Some(previous) = merged
            .artifacts
            .iter_mut()
            .find(|item| item.safe_path_label == artifact.safe_path_label)
        {
            artifact.deliverable |= previous.deliverable;
            artifact.source = artifact.source.or_else(|| previous.source.clone());
            *previous = artifact;
        } else {
            merged.artifacts.push(artifact);
        }
    }
    merged.artifacts.sort_by_key(|a| !a.deliverable);
    merged.artifacts.truncate(12);
    merged
}
