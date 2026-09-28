//! Profile extraction: reading user-authored conversation text, asking the
//! extractor model for profile candidates (`capture`), importing another
//! assistant's export (`import`), and committing what comes back.

mod capture;
mod commit;
mod coverage;
mod discovery;
mod import;
#[cfg(test)]
pub(crate) use import::tests::persisted_import_normalization_hash_and_id_are_stable;
mod parser;
mod prompt;
#[cfg(test)]
pub(crate) use prompt::tests::persisted_window_coverage_key_and_evidence_ref_are_stable;
mod result;
mod runtime;
mod targets;
mod types;

use parking_lot::Mutex;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::contracts::*;
use crate::coordination::CognitionWriteCoordinator;
use butler_models::models::ProviderPromptPort;
pub(super) use capture::capture;

pub(super) struct Dependencies {
    pub root: PathBuf,
    pub lock: PathBuf,
    pub coordinator: Arc<CognitionWriteCoordinator>,
    pub host: Arc<dyn ProfileHostFacts>,
    pub sources: Arc<dyn CanonicalProfileSourceFactory>,
    pub provider: Arc<dyn ProviderPromptPort>,
    pub active_claims: Arc<Mutex<HashSet<String>>>,
}

pub(super) async fn import(
    dependencies: Dependencies,
    options: ProfileThirdPartyImportOptions,
    cancellation: CancellationToken,
) -> ProfileResult<ProfileThirdPartyImportResult> {
    import::run(dependencies, options, cancellation).await
}
