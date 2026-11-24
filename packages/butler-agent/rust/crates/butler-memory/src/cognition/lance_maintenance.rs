//! Keeping a generation's Lance table small: few fragments, a bounded number
//! of retained versions, and scalar indexes on the columns filters use.
//!
//! Every write adds a fragment and a version, so an unmaintained table grows
//! without bound and every search pays for each fragment it opens. Callers
//! run physical maintenance after releasing the memory write lease. Lance
//! publishes replacement fragments atomically without changing logical rows.

use lancedb::{
    Table,
    index::{
        Index,
        scalar::{BTreeIndexBuilder, BitmapIndexBuilder},
    },
    table::{CompactionOptions, OptimizeAction, OptimizeOptions},
};

#[cfg(feature = "e2e-fixtures")]
mod fixtures;

/// Rows a compacted fragment holds. Compaction merges only fragments below
/// this size (plus, by Lance's default `materialize_deletions`, fragments with
/// over 10% deleted rows), so its cost is bounded by the small tail, not the
/// table size.
pub(super) const TARGET_ROWS_PER_FRAGMENT: usize = 8192;
/// Trailing fragments smaller than [`TARGET_ROWS_PER_FRAGMENT`] a table may hold
/// before writers compact them.
pub(super) const FRAGMENT_LIMIT: usize = 32;
/// Versions kept for rollback: the newest ones, plus any that carry a tag.
/// Older versions are pruned, because a table restored to a version older
/// than that would lose more writes than a restore is worth.
pub(super) const RETAINED_VERSIONS: usize = 32;

/// What a maintenance pass did.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Maintained {
    /// Fragments were merged.
    pub compacted: bool,
    /// Old versions removed.
    pub versions_pruned: u64,
    /// Scalar indexes created.
    pub indexes_created: usize,
}

/// The columns filters select on and the index kind that suits each: unique
/// keys use a B-tree, the two low-cardinality columns a bitmap.
fn wanted_indexes() -> [(&'static str, Index); 3] {
    [
        ("vector_key", Index::BTree(BTreeIndexBuilder::default())),
        ("record_kind", Index::Bitmap(BitmapIndexBuilder::default())),
        (
            "embedding_version",
            Index::Bitmap(BitmapIndexBuilder::default()),
        ),
    ]
}

/// Compacts the trailing small fragments, where appends land, when more than
/// [`FRAGMENT_LIMIT`] exist. Returns whether any fragment was rewritten.
pub(super) async fn compact_if_fragmented(table: &Table) -> lancedb::Result<bool> {
    let Some(dataset) = table.dataset() else {
        return Ok(false);
    };
    let tail = dataset
        .get()
        .await?
        .get_fragments()
        .iter()
        .rev()
        .take_while(|fragment| {
            fragment
                .metadata()
                .physical_rows
                .is_none_or(|rows| rows < TARGET_ROWS_PER_FRAGMENT)
        })
        .count();
    if tail <= FRAGMENT_LIMIT {
        return Ok(false);
    }
    let started = std::time::Instant::now();
    let action = OptimizeAction::Compact {
        options: CompactionOptions {
            target_rows_per_fragment: TARGET_ROWS_PER_FRAGMENT,
            ..Default::default()
        },
        remap_options: None,
    };
    #[cfg(feature = "e2e-fixtures")]
    let (action, _hold) = fixtures::instrument(action);
    let stats = table.optimize(action).await?;
    if std::env::var("BUTLER_MEMORY_SYNC_TRACE").as_deref() == Ok("1") {
        butler_core::diagnostic!(
            "[memory-vector] compact_ms={:.3}",
            started.elapsed().as_secs_f64() * 1000.0
        );
    }
    Ok(stats
        .compaction
        .is_some_and(|metrics| metrics.fragments_removed > 0))
}

/// Removes every version older than the newest [`RETAINED_VERSIONS`]; tagged
/// versions stay. Returns the number of versions removed.
pub(super) async fn prune_old_versions(table: &Table) -> lancedb::Result<u64> {
    let mut versions = table.list_versions().await?;
    if versions.len() <= RETAINED_VERSIONS {
        return Ok(0);
    }
    versions.sort_by_key(|version| version.version);
    let Some(oldest_kept) = versions.get(versions.len() - RETAINED_VERSIONS) else {
        return Ok(0);
    };
    let age = chrono::Utc::now() - oldest_kept.timestamp;
    let stats = table
        .optimize(OptimizeAction::Prune {
            older_than: Some(age),
            // Files no manifest names may belong to a write in progress.
            delete_unverified: Some(false),
            // A tagged old version is kept on purpose, not an error.
            error_if_tagged_old_versions: Some(false),
        })
        .await?;
    let removed = stats.prune.map_or(0, |removed| removed.old_versions);
    if std::env::var("BUTLER_MEMORY_SYNC_TRACE").as_deref() == Ok("1") {
        butler_core::diagnostic!(
            "[memory-vector] versions_pruned={removed} version={}",
            table.version().await?
        );
    }
    Ok(removed)
}

/// Creates the scalar indexes the table lacks and folds rows written since
/// into the existing ones. Returns the number of indexes created.
pub(super) async fn ensure_indexes(table: &Table) -> lancedb::Result<usize> {
    if table.count_rows(None).await? == 0 {
        return Ok(0);
    }
    let existing = table.list_indices().await?;
    let mut created = 0;
    for (column, index) in wanted_indexes() {
        let present = existing
            .iter()
            .any(|config| config.columns.iter().any(|name| name == column));
        if !present {
            table.create_index(&[column], index).execute().await?;
            created += 1;
        }
    }
    if created == 0 {
        table
            .optimize(OptimizeAction::Index(OptimizeOptions::default()))
            .await?;
    }
    Ok(created)
}

/// One full maintenance pass. Prunes before compacting so a deadline that
/// stops a long compaction cannot skip it, and again after a compaction so
/// superseded versions do not accumulate. The fragments a compaction just
/// rewrote stay on disk while the retained versions still reference them, so
/// the steady state is about two copies of the small tail.
pub(crate) async fn maintain(table: &Table) -> lancedb::Result<Maintained> {
    let mut versions_pruned = prune_old_versions(table).await?;
    let compacted = compact_if_fragmented(table).await?;
    if compacted {
        versions_pruned += prune_old_versions(table).await?;
    }
    let indexes_created = ensure_indexes(table).await?;
    Ok(Maintained {
        compacted,
        versions_pruned,
        indexes_created,
    })
}
