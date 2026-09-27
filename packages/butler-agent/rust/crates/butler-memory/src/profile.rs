//! The user profile: candidate facts extracted from conversations, their
//! review state, and the profile section projected into prompts.

mod candidates;
mod contracts;
mod coverage_health;
mod error;
mod extraction;
mod extractor_config;
mod migration_prompt;
mod naming;
mod onboarding;
mod presets;
mod projection;
mod service;
mod storage;

pub use contracts::{
    CanonicalProfileMessage, CanonicalProfilePart, CanonicalProfileScalar, CanonicalProfileScan,
    CanonicalProfileSourceFactory, CanonicalProfileSourceReader, ClearProfilingResult,
    FirstChatOnboardingUpdate, PersonalizationProfile, PersonalizationProfileUpdate, ProfileError,
    ProfileHostFacts, ProfileModelTranscriptCaptureOptions, ProfileResult,
    ProfileThirdPartyImportOptions, ProfilingConsentSnapshot, ProfilingExtractorModelSnapshot,
    ProfilingMode, RuntimeProfileProjection,
};
pub use coverage_health::ProfileCoverageHealth;
pub use error::ProfileCode;
pub(crate) use extractor_config::read as read_profiling_extractor_model;
pub use migration_prompt::third_party_migration_prompt;
pub use presets::{PersonaLocale, PersonaPreset, PersonaPresets};
pub use service::ProfileService;

pub fn first_chat_onboarding_complete(data_root: &std::path::Path, now: &str) -> bool {
    onboarding::read(data_root, now).status == "complete"
}

pub fn active_briefing_persona(data_root: &std::path::Path) -> (Option<String>, Option<String>) {
    let text = std::fs::read_to_string(data_root.join("personas/active.md"))
        .ok()
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty());
    let id = text.as_ref().map(|_| "active".to_owned());
    (id, text)
}

#[cfg(test)]
mod tests;
