//! One tracked blocking probe, independent of the observer's admission lane.
use super::*;
use butler_memory::cognition::{CognitionEmbeddingPort, GenerationVectorAdapter};

pub(super) struct Prewarm {
    runtime: tokio::runtime::Handle,
    data_root: std::path::PathBuf,
    paths: CognitionPathEnvironment,
    embedding: Option<Arc<crate::host::EmbeddingOwner>>,
    probe: Option<tokio::task::JoinHandle<()>>,
}

impl Prewarm {
    pub(super) fn new(
        data_root: &Path,
        paths: &CognitionPathEnvironment,
        embedding: Option<Arc<crate::host::EmbeddingOwner>>,
    ) -> Self {
        Self {
            runtime: tokio::runtime::Handle::current(),
            data_root: data_root.to_owned(),
            paths: paths.clone(),
            embedding,
            probe: None,
        }
    }

    pub(super) fn on_admission(&mut self, input: &AdmissionMetric) {
        let Some(embedding) = &self.embedding else {
            return;
        };
        if !input.admitted
            || input.event_kind != "inbound.accepted"
            || !embedding.enabled()
            || self
                .probe
                .as_ref()
                .is_some_and(|probe| !probe.is_finished())
        {
            return;
        }
        let data_root = self.data_root.clone();
        let paths = self.paths.clone();
        let embedding = embedding.clone();
        self.probe = Some(self.runtime.spawn_blocking(move || {
            if GenerationVectorAdapter::has_recall_vectors(&data_root, &paths).unwrap_or(false) {
                embedding.start_loading();
            }
        }));
    }

    pub(super) fn drain(self) {
        if let Some(probe) = self.probe {
            let _ = self.runtime.block_on(probe);
        }
    }
}
