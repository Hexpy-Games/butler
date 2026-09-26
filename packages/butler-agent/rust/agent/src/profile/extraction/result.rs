use super::super::contracts::*;
use super::types::{CoverageCounts, SourceRead};

pub(super) fn interruption(error: &ProfileError) -> bool {
    matches!(
        error.message.as_str(),
        "memory_write_busy"
            | "profile source changed"
            | "profile correction target changed"
            | "profiling consent changed"
    )
}
pub(super) fn safe_error(error: &ProfileError) -> String {
    if error.message.starts_with("profile ") {
        super::super::naming::bounded(&error.message, 120)
    } else {
        "profile extractor response failed validation".into()
    }
}
pub(super) fn empty_result(
    model: ProfilingExtractorModelSnapshot,
    consent: ProfilingConsentSnapshot,
) -> ProfileModelTranscriptCaptureResult {
    result(CaptureResultInput {
        read: &SourceRead {
            scanned_session_count: 0,
            scanned_message_count: 0,
            windows: Vec::new(),
            discovery_incomplete: false,
            current_obligation_count: 0,
            stale_keys: Vec::new(),
            persistent_offset: None,
        },
        mode: consent.mode,
        model,
        called: false,
        usage: ProfileModelUsageSummary::default(),
        error: None,
        counts: Default::default(),
        incomplete: false,
        captured: 0,
    })
    .with_mode(consent.mode, false)
}

pub(super) struct CaptureResultInput<'a> {
    pub(super) read: &'a SourceRead,
    pub(super) mode: ProfilingMode,
    pub(super) model: ProfilingExtractorModelSnapshot,
    pub(super) called: bool,
    pub(super) usage: ProfileModelUsageSummary,
    pub(super) error: Option<String>,
    pub(super) counts: CoverageCounts,
    pub(super) incomplete: bool,
    pub(super) captured: usize,
}

pub(super) fn result(input: CaptureResultInput<'_>) -> ProfileModelTranscriptCaptureResult {
    let CaptureResultInput {
        read,
        mode,
        model,
        called,
        usage,
        error,
        counts,
        incomplete,
        captured,
    } = input;
    ProfileModelTranscriptCaptureResult {
        profiling_enabled: true,
        mode,
        scanned_file_count: read.scanned_session_count,
        scanned_event_count: read.scanned_message_count,
        semantic_scanned_session_count: read.scanned_session_count,
        semantic_scanned_message_count: read.scanned_message_count,
        audit_transcript_scanned_file_count: 0,
        audit_transcript_scanned_event_count: 0,
        captured_candidate_count: captured,
        raw_text_included: false,
        extractor_model: model,
        model_called: called,
        fallback_used: false,
        model_usage: usage,
        model_error: error,
        coverage_pending_count: Some(counts.pending),
        coverage_failed_count: Some(counts.failed),
        coverage_complete_count: Some(counts.complete),
        coverage_discovery_incomplete_count: Some(usize::from(incomplete)),
    }
}
trait ResultMode {
    fn with_mode(self, mode: ProfilingMode, enabled: bool) -> Self;
}
impl ResultMode for ProfileModelTranscriptCaptureResult {
    fn with_mode(mut self, mode: ProfilingMode, enabled: bool) -> Self {
        self.mode = mode;
        self.profiling_enabled = enabled;
        if !enabled {
            self.coverage_pending_count = None;
            self.coverage_failed_count = None;
            self.coverage_complete_count = None;
            self.coverage_discovery_incomplete_count = None;
        }
        self
    }
}
