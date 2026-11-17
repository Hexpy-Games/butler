//! Bound Work per turn, reused while the Ledger generation, its claim, the turn's BTCC hint and the Work's record are unchanged.
//! Outside a claim, only edits to a cached Work's work.md are detected; Ledger writers otherwise hold a claim.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::super::publication::{claim_held, read_generation};
use super::{BtccError, ProjectWorkRepository, WorkView};

#[derive(Default)]
pub(super) struct BoundTurns {
    generation: String,
    turns: HashMap<String, Cached>,
}

#[derive(Clone)]
struct Cached {
    hint: Option<String>,
    view: Option<WorkView>,
    record: Option<RecordStamp>,
}

#[derive(Clone, PartialEq, Eq)]
struct RecordStamp {
    len: u64,
    modified: std::time::SystemTime,
}

/// Bounds memory between Ledger writes; a cleared entry only costs one re-read.
const MAX_TURNS: usize = 256;

fn record_path(root: &Path, work_id: &str) -> PathBuf {
    root.join("work").join(work_id).join("work.md")
}

fn stamp(path: &Path) -> Option<RecordStamp> {
    crate::project_ledger::publication::timing::fs::metadata(path)
        .ok()
        .and_then(|m| {
            Some(RecordStamp {
                len: m.len(),
                modified: m.modified().ok()?,
            })
        })
}

impl ProjectWorkRepository {
    pub(super) async fn cached_bound_for_turn(
        &self,
        turn_id: String,
    ) -> Result<Option<WorkView>, BtccError> {
        let root = self.scope.ledger_root.clone();
        let task_lost = |source| {
            BtccError::relayed("project_work_task_lost", "Project Work operation stopped")
                .with_source(source)
        };
        let (generation, held) = tokio::task::spawn_blocking({
            let root = root.clone();
            move || {
                read_generation(&root)
                    .map(|generation| (generation, claim_held(&root)))
                    .map_err(super::publication::publication_error)
            }
        })
        .await
        .map_err(task_lost)??;
        if held {
            return self.bound_for_turn_impl(turn_id).await;
        }
        let hint = self.turn_binding_hint(&turn_id).await?;
        let cached = self
            .shared
            .bound
            .lock()
            .get(&root)
            .filter(|entry| entry.generation == generation)
            .and_then(|entry| entry.turns.get(&turn_id))
            .filter(|cached| cached.hint == hint)
            .cloned();
        if let Some(Cached { view, record, .. }) = cached {
            let Some(view) = view else { return Ok(None) };
            let path = record_path(&root, &view.work_id);
            let current = tokio::task::spawn_blocking(move || stamp(&path))
                .await
                .map_err(task_lost)?;
            if current == record {
                return Ok(Some(view));
            }
        }
        let view = self
            .bound_for_turn_hint(turn_id.clone(), hint.clone())
            .await?;
        let path = view.as_ref().map(|view| record_path(&root, &view.work_id));
        let record = tokio::task::spawn_blocking(move || path.and_then(|path| stamp(&path)))
            .await
            .map_err(task_lost)?;
        let mut bound = self.shared.bound.lock();
        let entry = bound.entry(root).or_default();
        if entry.generation != generation || entry.turns.len() >= MAX_TURNS {
            entry.generation = generation;
            entry.turns.clear();
        }
        entry.turns.insert(
            turn_id,
            Cached {
                hint,
                view: view.clone(),
                record,
            },
        );
        Ok(view)
    }
}
