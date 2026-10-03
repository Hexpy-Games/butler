//! Shared attachment storage and prompt context owners.
use std::{path::Path, sync::Arc};
pub(super) fn owners(
    root: &Path,
) -> (
    Arc<butler_gateway::gateway::AppImageFiles>,
    Arc<butler_runtime::context::AttachmentContext>,
) {
    (
        Arc::new(butler_gateway::gateway::AppImageFiles::new(root)),
        Arc::new(butler_runtime::context::AttachmentContext::new(
            root.to_path_buf(),
        )),
    )
}
