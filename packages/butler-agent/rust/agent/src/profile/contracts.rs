use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

mod extraction;

pub(crate) use extraction::{
    ProfileModelTranscriptCaptureOptions, ProfileModelTranscriptCaptureResult,
    ProfileModelUsageSummary, ProfileThirdPartyImportOptions, ProfileThirdPartyImportResult,
    ProfileTranscriptCaptureOptions,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProfileError {
    pub code: &'static str,
    pub message: String,
}

impl ProfileError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for ProfileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ProfileError {}
pub(crate) type ProfileResult<T> = Result<T, ProfileError>;

pub(crate) trait ProfileHostFacts: Send + Sync {
    fn process_id(&self) -> u32;
    fn process_status(&self, pid: f64) -> crate::coordination::CognitionProcessStatus;
    fn new_uuid(&self) -> String;
    fn now_epoch_millis(&self) -> i64;
    fn now_iso(&self) -> String;
}

pub(crate) trait CanonicalProfileSourceFactory: Send + Sync {
    fn open(&self) -> ProfileResult<Box<dyn CanonicalProfileSourceReader>>;
}

pub(crate) trait CanonicalProfileSourceReader: Send {
    fn read_cognition_messages(
        &mut self,
        scan: CanonicalProfileScan,
    ) -> ProfileResult<Vec<CanonicalProfileMessage>>;
    fn read_message(&mut self, id: &str) -> ProfileResult<Option<CanonicalProfileMessage>>;
    fn close(self: Box<Self>) -> ProfileResult<()>;
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CanonicalProfileScan {
    pub since: Option<String>,
    pub offset: f64,
    pub limit: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CanonicalProfileMessage {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub origin_kind: String,
    pub created_at: String,
    pub parts: Vec<CanonicalProfilePart>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CanonicalProfilePart {
    pub part_id: String,
    pub part_index: f64,
    pub scalars: Vec<CanonicalProfileScalar>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CanonicalProfileScalar {
    pub pointer: String,
    pub source_hash: String,
    pub text: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub(crate) struct PersonalizationProfile {
    pub butler_nickname: String,
    pub principal_name: String,
    pub preferred_address: String,
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct PersonalizationProfileUpdate {
    pub butler_nickname: Option<String>,
    pub principal_name: Option<String>,
    pub preferred_address: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProfilingMode {
    Off,
    Basic,
    Deep,
}

impl ProfilingMode {
    pub(crate) fn parse(value: &str) -> Self {
        match value {
            "basic" => Self::Basic,
            "deep" => Self::Deep,
            _ => Self::Off,
        }
    }
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Basic => "basic",
            Self::Deep => "deep",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct ProfilingConsentSnapshot {
    pub mode: ProfilingMode,
    pub consent_version: String,
    pub consented_at: Option<String>,
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

#[derive(Clone, Debug, Default)]
pub(crate) struct FirstChatOnboardingUpdate {
    pub principal_name: Option<String>,
    pub preferred_address: Option<String>,
    pub butler_nickname: Option<String>,
    pub interests: Option<String>,
    pub work: Option<String>,
    pub service_preference: Option<String>,
    pub persona_preset: Option<String>,
    pub persona_custom: Option<String>,
    pub profiling_mode: Option<ProfilingMode>,
    pub skipped_fields: Vec<String>,
    pub complete: bool,
    pub locale: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct FirstChatOnboardingUpdateResult {
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
pub(crate) struct OnboardingProfileResult {
    pub has_principal_name: bool,
    pub has_preferred_address: bool,
    pub has_butler_nickname: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct OnboardingPersonaResult {
    pub preset: Option<String>,
    pub applied: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct OnboardingProfilingResult {
    pub mode: ProfilingMode,
    pub captured_candidate_count: usize,
    pub raw_text_included: bool,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(default)]
pub(crate) struct RuntimeProfileProjection {
    pub version: f64,
    pub mode: String,
    pub updated_at: String,
    pub how_to_answer: Vec<String>,
    pub how_to_collaborate: Vec<String>,
    pub response_hints: Vec<String>,
    pub current_attention: Vec<String>,
    pub active_boundaries: Vec<String>,
    pub likely_failure_modes: Vec<String>,
    pub ask_before: Vec<String>,
    pub caution_hints: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub writer_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_entry_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct ClearProfilingResult {
    pub removed_candidates: usize,
    pub removed_stable_entries: usize,
    pub removed_runtime_projections: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct ReflectiveProfileSummary {
    pub ok: bool,
    pub profiling_enabled: bool,
    pub mode: ProfilingMode,
    pub entry_count: usize,
    pub summary: String,
    pub bullets: Vec<String>,
    pub raw_profile_included: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProfileCandidateInput {
    pub category: String,
    pub payload: Value,
    pub source_type: String,
    pub confidence: String,
    pub sensitive_domain: bool,
    pub evidence_ref: Option<String>,
    pub evidence_observed_at: Option<String>,
    pub expires_or_decay: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProfileCandidateRecord {
    pub id: String,
    pub payload: Value,
}

impl Serialize for ProfileCandidateRecord {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("id", &self.id)?;
        for key in [
            "layer",
            "category",
            "facet",
            "summary",
            "applies_when",
            "butler_should",
            "butler_should_not",
            "temporal_scope",
            "decay_policy",
            "contradiction_refs",
            "sensitivity",
            "evidence_refs",
            "evidence_observed_at",
            "evidence_count",
            "source_type",
            "confidence",
            "sensitive_domain",
            "status",
            "created_at",
            "updated_at",
            "last_seen_at",
            "expires_or_decay",
            "promoted_at",
        ] {
            if let Some(value) = self.payload.get(key) {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct ProfileConsolidationResult {
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct ProfilingExtractorModelSnapshot {
    pub configured_model: Option<String>,
    pub reasoning_effort: String,
    pub effective_model: String,
    pub uses_butler_model: bool,
}
