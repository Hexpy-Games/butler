//! Public profile types: host and source ports, names, consent, onboarding and projections.

use serde::{Deserialize, Serialize};

use super::understanding::{
    CandidateDraft, CandidateStatus, Confidence, Expiry, Layer, SourceType, Understanding,
};

mod extraction;

pub use extraction::{ProfileModelTranscriptCaptureOptions, ProfileThirdPartyImportOptions};
pub(crate) use extraction::{
    ProfileModelTranscriptCaptureResult, ProfileModelUsageSummary, ProfileThirdPartyImportResult,
    ProfileTranscriptCaptureOptions,
};

pub use super::error::ProfileError;
/// Result of a profile operation.
pub type ProfileResult<T> = Result<T, ProfileError>;

/// Process and clock facts the profile service needs from its host.
pub trait ProfileHostFacts: Send + Sync {
    /// This process id, recorded as the owner of claimed source windows.
    fn process_id(&self) -> u32;
    /// Whether the process with `pid` is alive, dead or unknown.
    fn process_status(&self, pid: f64) -> crate::coordination::CognitionProcessStatus;
    /// A fresh unique id.
    fn new_uuid(&self) -> String;
    /// Now, in milliseconds since the Unix epoch.
    fn now_epoch_millis(&self) -> i64;
    /// Now, as an ISO 8601 time with milliseconds.
    fn now_iso(&self) -> String;
}

/// Opens readers over the canonical conversation store.
pub trait CanonicalProfileSourceFactory: Send + Sync {
    /// A reader over the canonical conversation store.
    fn open(&self) -> ProfileResult<Box<dyn CanonicalProfileSourceReader>>;
    /// Whether an explicit feedback receipt still authorizes this candidate or destination.
    fn verified_feedback(&self, _reference: &str, _destination: &str) -> ProfileResult<bool> {
        Ok(false)
    }
}

/// Reads user-authored conversation messages for profile extraction.
pub trait CanonicalProfileSourceReader: Send {
    /// A page of messages the profile may learn from.
    fn read_cognition_messages(
        &mut self,
        scan: CanonicalProfileScan,
    ) -> ProfileResult<Vec<CanonicalProfileMessage>>;
    /// The message with `id`, when it still exists.
    fn read_message(&mut self, id: &str) -> ProfileResult<Option<CanonicalProfileMessage>>;
    /// Closes the reader.
    fn close(self: Box<Self>) -> ProfileResult<()>;
}

/// A page request over the canonical conversation messages.
#[derive(Clone, Debug, PartialEq)]
pub struct CanonicalProfileScan {
    /// Only messages created at or after this time, when set.
    pub since: Option<String>,
    /// Messages to skip.
    pub offset: f64,
    /// Messages to return at most.
    pub limit: f64,
}

/// A canonical conversation message, as the profile reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct CanonicalProfileMessage {
    /// Message id.
    pub id: String,
    /// Conversation session the message belongs to.
    pub session_id: String,
    /// Author role (`user` or `assistant`).
    pub role: String,
    /// How the message entered the conversation (`user_input` for typed user text).
    pub origin_kind: String,
    /// When the message was created (ISO 8601).
    pub created_at: String,
    /// Message parts in order.
    pub parts: Vec<CanonicalProfilePart>,
}

/// One part of a canonical message.
#[derive(Clone, Debug, PartialEq)]
pub struct CanonicalProfilePart {
    /// Part id.
    pub part_id: String,
    /// Position of the part in its message.
    pub part_index: f64,
    /// Text scalars of the part.
    pub scalars: Vec<CanonicalProfileScalar>,
}

/// One text scalar of a message part.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonicalProfileScalar {
    /// JSON pointer of the scalar inside the part content.
    pub pointer: String,
    /// SHA-256 of the scalar text.
    pub source_hash: String,
    /// The text.
    pub text: String,
}

/// How Butler and the user are named.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct PersonalizationProfile {
    /// What the user calls Butler.
    pub butler_nickname: String,
    /// The user's name.
    pub principal_name: String,
    /// How Butler addresses the user.
    pub preferred_address: String,
    /// When the names were last changed.
    pub updated_at: Option<String>,
}

/// A change to the names; `None` keeps the current value.
#[derive(Clone, Debug, Default)]
pub struct PersonalizationProfileUpdate {
    /// New name for Butler.
    pub butler_nickname: Option<String>,
    /// New name for the user.
    pub principal_name: Option<String>,
    /// New form of address.
    pub preferred_address: Option<String>,
}

/// How much Butler may learn about the user.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfilingMode {
    /// No profiling.
    Off,
    /// Communication, epistemic style and boundaries only.
    Basic,
    /// Every profile category.
    Deep,
}

impl ProfilingMode {
    /// The mode with this stored name; `off` for anything unknown.
    pub fn parse(value: &str) -> Self {
        match value {
            "basic" => Self::Basic,
            "deep" => Self::Deep,
            _ => Self::Off,
        }
    }
    /// The stored name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Basic => "basic",
            Self::Deep => "deep",
        }
    }
}

/// The profiling consent in effect.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProfilingConsentSnapshot {
    /// Consented profiling mode.
    pub mode: ProfilingMode,
    /// Version of the consent text the user agreed to.
    pub consent_version: String,
    /// When consent was given; `None` while profiling is off.
    pub consented_at: Option<String>,
    /// Whether the raw profile may be shown in the browser (always `false`).
    pub raw_profile_browser_visible: bool,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub(crate) struct FirstChatOnboardingFields {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interests: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_preference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona_preset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona_custom: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profiling_mode: Option<ProfilingMode>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub(crate) struct FirstChatOnboardingState {
    pub schema: String,
    pub status: String,
    pub gateway: String,
    pub fields: FirstChatOnboardingFields,
    pub skipped_fields: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

/// Answers from a first-chat onboarding turn; `None` leaves a field unchanged.
#[derive(Clone, Debug, Default)]
pub struct FirstChatOnboardingUpdate {
    /// The user's name.
    pub principal_name: Option<String>,
    /// How Butler should address the user.
    pub preferred_address: Option<String>,
    /// What the user calls Butler.
    pub butler_nickname: Option<String>,
    /// What the user is interested in.
    pub interests: Option<String>,
    /// The user's work or field.
    pub work: Option<String>,
    /// How the user wants Butler to help.
    pub service_preference: Option<String>,
    /// Chosen persona preset id.
    pub persona_preset: Option<String>,
    /// Custom persona text.
    pub persona_custom: Option<String>,
    /// Chosen profiling mode.
    pub profiling_mode: Option<ProfilingMode>,
    /// Onboarding questions the user skipped.
    pub skipped_fields: Vec<String>,
    /// Whether onboarding is complete.
    pub complete: bool,
    /// Locale of the conversation (`ko` or English).
    pub locale: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FirstChatOnboardingUpdateResult {
    pub ok: bool,
    pub status: String,
    pub updated_fields: Vec<String>,
    pub skipped_fields: Vec<String>,
    pub profile: OnboardingProfileResult,
    pub persona: OnboardingPersonaResult,
    pub profiling: OnboardingProfilingResult,
    pub storage_label: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OnboardingProfileResult {
    pub has_principal_name: bool,
    pub has_preferred_address: bool,
    pub has_butler_nickname: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OnboardingPersonaResult {
    pub preset: Option<String>,
    pub applied: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OnboardingProfilingResult {
    pub mode: ProfilingMode,
    pub captured_candidate_count: usize,
    pub raw_text_included: bool,
}

/// Adaptation hints projected from the stable profile into prompts.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(default)]
pub struct RuntimeProfileProjection {
    /// Projection version (the time it was generated, in milliseconds).
    pub version: f64,
    /// Profiling mode the projection was built under.
    pub mode: String,
    /// When the projection was written.
    pub updated_at: String,
    /// How to shape answers.
    pub how_to_answer: Vec<String>,
    /// How to work together.
    pub how_to_collaborate: Vec<String>,
    /// Answer hints (the same as `how_to_answer`, kept for older readers).
    pub response_hints: Vec<String>,
    /// What the user is currently focused on.
    pub current_attention: Vec<String>,
    /// Boundaries to respect.
    pub active_boundaries: Vec<String>,
    /// Ways Butler is likely to get it wrong.
    pub likely_failure_modes: Vec<String>,
    /// What to ask before doing.
    pub ask_before: Vec<String>,
    /// Every caution: boundaries, failure modes and questions to ask first.
    pub caution_hints: Vec<String>,
    /// `generated` from the profile, or `manual` when written by hand.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub writer_kind: Option<String>,
    /// Stable profile entries the projection was built from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_entry_ids: Option<Vec<String>>,
}

/// What clearing the profile removed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ClearProfilingResult {
    /// Candidates removed.
    pub removed_candidates: usize,
    /// Stable entries removed.
    pub removed_stable_entries: usize,
    /// Runtime projections removed.
    pub removed_runtime_projections: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ReflectiveProfileSummary {
    pub ok: bool,
    pub profiling_enabled: bool,
    pub mode: ProfilingMode,
    pub entry_count: usize,
    pub summary: String,
    pub bullets: Vec<String>,
    pub raw_profile_included: bool,
}

/// A candidate to merge into the profile store.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProfileCandidateInput {
    pub category: String,
    pub draft: CandidateDraft,
    pub source_type: SourceType,
    pub confidence: Confidence,
    pub sensitive_domain: bool,
    pub evidence_ref: Option<String>,
    pub evidence_observed_at: Option<String>,
    pub expires_or_decay: Option<Expiry>,
}

/// A profile candidate as stored, fields in the order the record serializes.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct ProfileCandidateRecord {
    pub id: String,
    pub layer: Layer,
    pub category: String,
    #[serde(flatten)]
    pub understanding: Understanding,
    pub source_type: SourceType,
    pub confidence: Confidence,
    pub sensitive_domain: bool,
    pub status: CandidateStatus,
    pub created_at: String,
    pub updated_at: String,
    pub last_seen_at: String,
    pub expires_or_decay: Option<Expiry>,
    pub promoted_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProfileConsolidationResult {
    pub profiling_enabled: bool,
    pub mode: ProfilingMode,
    pub candidate_count: usize,
    pub promoted_count: usize,
    pub skipped_count: usize,
    pub rejected_count: usize,
    pub stable_entry_count: usize,
    pub projection_written: bool,
    pub raw_text_included: bool,
}

/// The model the profile extractor uses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProfilingExtractorModelSnapshot {
    /// Model configured for the extractor, when set.
    pub configured_model: Option<String>,
    /// Reasoning effort for extractor requests.
    pub reasoning_effort: String,
    /// Model the extractor actually uses.
    pub effective_model: String,
    /// Whether the extractor falls back to Butler's own model.
    pub uses_butler_model: bool,
}

/// Lease-time authority and durable completion callbacks for an explicit feedback candidate.
pub struct ProfileFeedbackPromotion {
    /// Complete faithful preference text.
    pub text: String,
    /// Existing profile category.
    pub category: String,
    /// Idempotent feedback evidence reference.
    pub evidence_ref: String,
    /// Original observation time.
    pub observed_at: String,
    /// Validate the frozen feedback revision inside the profile lease.
    pub validate: std::sync::Arc<dyn Fn() -> ProfileResult<()> + Send + Sync>,
    /// Record the destination only after its accepted commit, in the same lease.
    pub committed: ProfileFeedbackCommit,
}

/// Records a committed profile destination while its owner holds the shared lease.
pub type ProfileFeedbackCommit = std::sync::Arc<dyn Fn(&str) -> ProfileResult<()> + Send + Sync>;
