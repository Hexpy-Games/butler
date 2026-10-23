//! Pause real compaction after replacement fragments are written, before commit.
//! Only fixture builds wrap Lance's normal index remapper.
use lance::{
    Dataset,
    dataset::{
        index::DatasetIndexRemapperOptions,
        optimize::{IndexRemapper, IndexRemapperOptions, RemappedIndex},
    },
};
use lancedb::table::OptimizeAction;
use std::{collections::HashMap, sync::Arc};
use tokio_util::sync::{CancellationToken, DropGuard};

pub(super) fn instrument(mut action: OptimizeAction) -> (OptimizeAction, DropGuard) {
    let cancellation = CancellationToken::new();
    if let OptimizeAction::Compact { remap_options, .. } = &mut action {
        *remap_options = Some(Arc::new(HeldOptions(cancellation.clone())));
    }
    (action, cancellation.drop_guard())
}

struct HeldOptions(CancellationToken);

impl IndexRemapperOptions for HeldOptions {
    fn create_remapper(&self, dataset: &Dataset) -> lance::Result<Box<dyn IndexRemapper>> {
        Ok(Box::new(HeldRemapper {
            inner: DatasetIndexRemapperOptions::default().create_remapper(dataset)?,
            cancellation: self.0.clone(),
        }))
    }
}

struct HeldRemapper {
    inner: Box<dyn IndexRemapper>,
    cancellation: CancellationToken,
}

#[async_trait::async_trait]
impl IndexRemapper for HeldRemapper {
    async fn remap_indices(
        &self,
        index_map: HashMap<u64, Option<u64>>,
        affected_fragment_ids: &[u64],
    ) -> lance::Result<Vec<RemappedIndex>> {
        let cancellation = self.cancellation.clone();
        tokio::task::spawn_blocking(move || {
            butler_platform::secure_fs::hold_point("memory_vector_compact", || {
                cancellation.is_cancelled()
            })
        })
        .await
        .map_err(|error| lance::Error::invalid_input(error.to_string()))?
        .map_err(|error| lance::Error::invalid_input(error.to_string()))?;
        self.inner
            .remap_indices(index_map, affected_fragment_ids)
            .await
    }
}
