use super::super::contracts::*;
use super::super::extraction;
use super::ProfileService;

impl ProfileService {
    pub(crate) async fn capture_profile_candidates_from_transcripts_with_model(
        &self,
        options: ProfileModelTranscriptCaptureOptions,
    ) -> ProfileResult<ProfileModelTranscriptCaptureResult> {
        let cancellation = options.cancellation.clone();
        let dependencies = self.extraction_dependencies();
        self.run_async(cancellation, move |child| {
            extraction::capture(dependencies, options, child)
        })
        .await
    }

    pub(crate) async fn import_profile_candidates_from_third_party_dump_with_model(
        &self,
        options: ProfileThirdPartyImportOptions,
    ) -> ProfileResult<ProfileThirdPartyImportResult> {
        let cancellation = options.cancellation.clone();
        let dependencies = self.extraction_dependencies();
        self.run_async(cancellation, move |child| {
            extraction::import(dependencies, options, child)
        })
        .await
    }

    fn extraction_dependencies(&self) -> extraction::Dependencies {
        extraction::Dependencies {
            root: self.data_root.clone(),
            lock: self.lock_path(),
            coordinator: self.coordinator.clone(),
            host: self.host.clone(),
            sources: self.canonical_sources.clone(),
            provider: self.provider.clone(),
            active_claims: self.active_claims.clone(),
        }
    }
}
