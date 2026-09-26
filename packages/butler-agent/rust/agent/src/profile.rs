//! Native personalization state and prompt projection boundary.

mod candidates;
mod contracts;
mod coverage_health;
mod extraction;
mod extractor_config;
mod migration_prompt;
mod naming;
mod onboarding;
mod presets;
mod projection;
mod service;
mod storage;

pub(crate) use contracts::{
    CanonicalProfileMessage, CanonicalProfilePart, CanonicalProfileScalar, CanonicalProfileScan,
    CanonicalProfileSourceFactory, CanonicalProfileSourceReader, ClearProfilingResult,
    FirstChatOnboardingUpdate, PersonalizationProfile, PersonalizationProfileUpdate, ProfileError,
    ProfileHostFacts, ProfileModelTranscriptCaptureOptions, ProfileResult,
    ProfileThirdPartyImportOptions, ProfilingConsentSnapshot, ProfilingExtractorModelSnapshot,
    ProfilingMode, RuntimeProfileProjection,
};
pub(crate) use extractor_config::read as read_profiling_extractor_model;
pub(crate) use migration_prompt::third_party_migration_prompt;
pub(crate) use presets::{PersonaLocale, PersonaPreset, PersonaPresets};
pub(crate) use service::ProfileService;

pub(crate) fn first_chat_onboarding_complete(data_root: &std::path::Path, now: &str) -> bool {
    onboarding::read(data_root, now).status == "complete"
}

pub(crate) fn active_briefing_persona(
    data_root: &std::path::Path,
) -> (Option<String>, Option<String>) {
    let text = std::fs::read_to_string(data_root.join("personas/active.md"))
        .ok()
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty());
    let id = text.as_ref().map(|_| "active".to_owned());
    (id, text)
}

#[cfg(test)]
mod tests;
