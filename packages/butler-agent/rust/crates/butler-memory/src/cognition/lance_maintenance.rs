//! Keeping a generation's Lance table small: few fragments, a bounded number
//! of retained versions, and scalar indexes on the columns filters use.
//!
//! Every write adds a fragment and a version, so an unmaintained table grows
//! without bound and every search pays for each fragment it opens. Callers
//! hold the memory write lease.

use lancedb::{
    Table,
    index::{
        Index,
        scalar::{BTreeIndexBuilder, BitmapIndexBuilder},
    },
    table::{OptimizeAction, OptimizeOptions},
};

/// Fragments a table may hold before writers compact it.
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

/// Compacts the table when it holds more than [`FRAGMENT_LIMIT`] fragments.
/// Returns whether it did.
pub(super) async fn compact_if_fragmented(table: &Table) -> lancedb::Result<bool> {
    let fragments = table.stats().await?.fragment_stats.num_fragments;
    if fragments <= FRAGMENT_LIMIT {
        return Ok(false);
    }
    table
        .optimize(OptimizeAction::Compact {
            options: Default::default(),
            remap_options: None,
        })
        .await?;
    Ok(true)
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
    Ok(stats.prune.map_or(0, |removed| removed.old_versions))
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

/// One full maintenance pass.
pub(crate) async fn maintain(table: &Table) -> lancedb::Result<Maintained> {
    let compacted = compact_if_fragmented(table).await?;
    let versions_pruned = prune_old_versions(table).await?;
    let indexes_created = ensure_indexes(table).await?;
    Ok(Maintained {
        compacted,
        versions_pruned,
        indexes_created,
    })
}
