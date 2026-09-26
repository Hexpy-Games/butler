//! Source-compatible synchronous recall over the preserved legacy corpus.

mod corpus;
mod ranking;
mod types;

pub(crate) use types::{LegacyRecallRequest, LegacyRecallResponse};

use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use super::{CognitionError, CognitionPathEnvironment, CognitionResult, ensure_data_authority};
use crate::public_text::trim_js_whitespace;

pub(crate) fn recall_legacy(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    request: LegacyRecallRequest,
) -> CognitionResult<LegacyRecallResponse> {
    ensure_data_authority(data_root, &[data_root])?;
    let corpus = corpus::load(data_root, paths, request.project_id.as_deref())?;
    if trim_js_whitespace(&request.cue).is_empty() {
        return Err(CognitionError::new(
            "legacy_recall_invalid_cue",
            "recall cue requires text",
        ));
    }

    let now = request.now.unwrap_or_else(epoch_now_ms);
    Ok(ranking::recall_from_corpus(request, corpus, now))
}

fn epoch_now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as f64)
        .unwrap_or(0.0)
}
