//! Projection reads only the prefix whose boundary sync completed.
use std::{collections::HashMap, sync::Arc};

#[derive(Clone, Default)]
pub struct TranscriptVisibility(Arc<parking_lot::RwLock<HashMap<String, u64>>>);

impl TranscriptVisibility {
    pub(crate) fn limit(&self, name: &str, size: u64) -> u64 {
        self.0
            .read()
            .get(name)
            .copied()
            .map_or(size, |end| end.min(size))
    }

    pub(super) fn release(&self, name: &str) {
        self.0.write().remove(name);
    }

    pub(super) fn publish(&self, name: String, size: u64) {
        self.0.write().insert(name, size);
    }
}
