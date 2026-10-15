//! User-turn prefetch on the observer's blocking lane; no timers or startup work.
use super::*;
use butler_memory::cognition::{CognitionEmbeddingPort, GenerationVectorAdapter};

pub(super) fn on_admission(
    input: &AdmissionMetric,
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    embedding: Option<&crate::host::EmbeddingOwner>,
) {
    let Some(embedding) = embedding else { return };
    if !input.admitted
        || input.event_kind != "inbound.accepted"
        || !embedding.enabled()
        || embedding.is_warm()
    {
        return;
    }
    if GenerationVectorAdapter::has_recall_vectors(data_root, paths).unwrap_or(false) {
        embedding.start_loading();
    }
}
