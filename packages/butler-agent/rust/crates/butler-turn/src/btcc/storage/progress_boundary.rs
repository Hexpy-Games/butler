//! Awaited host publication at a runtime step's durability boundary.
use crate::btcc::PortFuture;
use std::sync::Arc;

type Sink = Arc<dyn Fn(String) -> PortFuture<'static, ()> + Send + Sync>;

#[derive(Default)]
pub(super) struct ProgressBoundary(parking_lot::RwLock<Option<Sink>>);

impl ProgressBoundary {
    pub(super) fn set_sink(&self, sink: Sink) {
        *self.0.write() = Some(sink);
    }

    pub(super) async fn flush(&self, session: String) -> Result<(), crate::btcc::BtccError> {
        let sink = self.0.read().clone();
        if let Some(sink) = sink {
            sink(session).await?;
        }
        Ok(())
    }
}

impl super::StorageProgressPublication {
    /// Await publication before exposing a directly read approval card.
    pub async fn flush_boundary(&self, session: String) -> Result<(), crate::btcc::BtccError> {
        self.storage.inner.boundary.flush(session).await
    }

    /// Installs the current transport publisher; capture that owner weakly.
    pub fn set_boundary_sink(&self, sink: Sink) {
        self.storage.inner.boundary.set_sink(sink);
    }
}
