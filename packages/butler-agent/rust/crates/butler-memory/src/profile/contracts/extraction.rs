//! Options and results of profile capture and third-party import.

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::{ProfilingExtractorModelSnapshot, ProfilingMode};

#[derive(Clone, Debug, Default)]
pub struct ProfileTranscriptCaptureOptions {
    pub max_user_messages: Option<f64>,
    pub since: Option<String>,
}

/// Options of a model-backed transcript capture.
#[derive(Clone, Debug)]
pub struct ProfileModelTranscriptCaptureOptions {
    /// Which messages to scan.
    pub scan: ProfileTranscriptCaptureOptions,
    /// Extractor model, overriding the configured one.
    pub model: Option<String>,
    /// Model requests at most (default 8, clamped to 1-120).
    pub max_model_batches: Option<f64>,
    /// Prompt cache scope (default `profile-extractor`).
    pub cache_scope: Option<String>,
    /// Stops the capture when cancelled.
    pub cancellation: CancellationToken,
}

impl Default for ProfileModelTranscriptCaptureOptions {
    fn default() -> Self {
        Self {
            scan: ProfileTranscriptCaptureOptions::default(),
            model: None,
            max_model_batches: None,
            cache_scope: None,
            cancellation: CancellationToken::new(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ProfileModelUsageSummary {
    pub request_count: f64,
    pub prompt_tokens: f64,
    pub cached_input_tokens: f64,
    pub uncached_input_tokens: f64,
    pub output_tokens: f64,
    pub total_tokens: f64,
    pub models: Vec<String>,
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "mirrors the serialized result schema field for field"
)]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProfileModelTranscriptCaptureResult {
    pub profiling_enabled: bool,
    pub mode: ProfilingMode,
    pub scanned_file_count: usize,
    pub scanned_event_count: usize,
    pub semantic_scanned_session_count: usize,
    pub semantic_scanned_message_count: usize,
    pub audit_transcript_scanned_file_count: usize,
    pub audit_transcript_scanned_event_count: usize,
    pub captured_candidate_count: usize,
    pub raw_text_included: bool,
    pub extractor_model: ProfilingExtractorModelSnapshot,
    pub model_called: bool,
    pub fallback_used: bool,
    pub model_usage: ProfileModelUsageSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coverage_pending_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coverage_failed_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coverage_complete_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coverage_discovery_incomplete_count: Option<usize>,
}

/// Options of an import of another assistant's export.
#[derive(Clone, Debug)]
pub struct ProfileThirdPartyImportOptions {
    /// Name of the assistant the export came from.
    pub source: Option<String>,
    /// The exported text.
    pub text: String,
    /// Extractor model, overriding the configured one.
    pub model: Option<String>,
    /// Import time (milliseconds since the epoch), for reproducible ids.
    pub now_epoch_millis: Option<f64>,
    /// Stops the import when cancelled.
    pub cancellation: CancellationToken,
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "mirrors the serialized result schema field for field"
)]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProfileThirdPartyImportResult {
    pub profiling_enabled: bool,
    pub mode: ProfilingMode,
    pub source: String,
    pub import_id: Option<String>,
    pub imported_candidate_count: usize,
    pub promoted_count: usize,
    pub skipped_count: usize,
    pub stable_entry_count: usize,
    pub projection_written: bool,
    pub raw_text_included: bool,
    pub extractor_model: ProfilingExtractorModelSnapshot,
    pub model_called: bool,
    pub fallback_used: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_error: Option<String>,
}
