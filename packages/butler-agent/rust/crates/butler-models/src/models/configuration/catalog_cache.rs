//! Reuse catalog construction, after every caller has read fresh file facts.
use std::{collections::VecDeque, sync::Arc};

use parking_lot::Mutex;
use serde_json::json;

use butler_core::locale::LocaleCollation;

use crate::models::{
    ModelCatalog, ModelCatalogError, ModelCatalogSnapshot, ModelCatalogSnapshotInput,
};

const CACHE_ENTRIES: usize = 8;
const KEY_BYTES: usize = 4 * 1024 * 1024;

#[derive(Default)]
pub(super) struct Cache(Mutex<VecDeque<(String, Arc<ModelCatalogSnapshot>)>>);

impl Cache {
    pub(super) fn snapshot(
        &self,
        catalog: &ModelCatalog,
        input: ModelCatalogSnapshotInput,
        collation: &LocaleCollation,
    ) -> Result<ModelCatalogSnapshot, ModelCatalogError> {
        // This cache belongs to one configuration owner: its static catalog
        // and collation never change. Include every dynamic construction fact,
        // preserving field order; only observation time is request-owned.
        let key = butler_core::json::stringify(&json!({
            "configured_local":input.configured_local,
            "extra_models":input.extra_models,
            "registered_models":input.registered_models,
            "credential_views":input.credential_views,
            "default_model_ref":input.default_model_ref,
        }))
        .map_err(ModelCatalogError::CatalogJson)?;
        let mut cache = self.0.lock();
        if let Some(index) = cache.iter().position(|(old, _)| old == &key)
            && let Some((key, snapshot)) = cache.remove(index)
        {
            let result = snapshot.with_generated_at(input.generated_at);
            cache.push_back((key, snapshot));
            return Ok(result);
        }
        let snapshot = catalog.snapshot(input, collation)?;
        if key.len() <= KEY_BYTES {
            let retained =
                Arc::new(snapshot.with_generated_at(snapshot.view().generated_at.clone()));
            if cache.len() >= CACHE_ENTRIES {
                cache.pop_front();
            }
            cache.push_back((key, retained));
        }
        Ok(snapshot)
    }
}
