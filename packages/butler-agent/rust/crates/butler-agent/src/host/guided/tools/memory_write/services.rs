//! Process composition and targeted startup recovery for remembered rules.
use butler_memory::cognition::{
    CognitionPathEnvironment, CompletionPublisher, RememberedRuleOwner,
};
use butler_memory::coordination::CognitionWriteCoordinator;
use std::{path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(crate) struct MemoryWriteServices {
    pub(in crate::host) paths: CognitionPathEnvironment,
    pub(in crate::host) publisher: Arc<CompletionPublisher>,
    pub(in crate::host) rules: RememberedRuleOwner,
}

impl MemoryWriteServices {
    pub(in crate::host) fn new(
        data: &Path,
        paths: &CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
        clock: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> Self {
        let publisher = Arc::new(CompletionPublisher::new(data, paths, clock));
        Self {
            paths: paths.clone(),
            rules: RememberedRuleOwner::new(
                data.to_owned(),
                paths.clone(),
                coordinator,
                publisher.clone(),
            ),
            publisher,
        }
    }

    pub(in crate::host) fn recover_at_startup(&self, stop: CancellationToken) {
        let rules = self.rules.clone();
        // A targeted startup request only: no periodic scan, new worker or admission wait.
        tokio::spawn(async move {
            if let Err(error) = rules.recover(stop).await {
                butler_core::diagnostic!(
                    "[memory] remembered rule recovery pending: {}",
                    error.code()
                );
            }
        });
    }
}
