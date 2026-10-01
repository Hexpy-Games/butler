//! Bounded conversation context compilation and model-aware budget policy.

mod attachment;
mod budget;
mod compaction;
mod conversation;
mod conversation_session_reference;
mod conversation_tools;
mod error;
mod image;
mod memory_source;
mod pdf;
mod prompt;
mod recent;
mod round_projection;
mod status;
mod status_conversation;
mod status_transcript_activity;
mod tool_artifact_slice;
mod tool_output;
#[cfg(test)]
pub(crate) use tool_output::tests::reader_cases::reader_enforces_scan_limit_and_realpath_boundary;

pub use attachment::AttachmentContext;
pub use budget::*;
pub use butler_turn::conversation::text_for_message;
pub use compaction::{
    CompactionMetricEvent, ContextCompactionMetricSink, compact_transcript,
    compaction_snapshot_path,
};
pub use conversation::*;
pub use conversation_session_reference::ConversationSessionReference;
pub use conversation_tools::ConversationTools;
pub use error::{ContextCode, ContextError};
pub use image::{
    ImageCapabilityEvidence, ImageCarrierTuple, ImageSanitizerInput, ImageSanitizerLimits,
    ImageSourceRecord, VisualAttachmentManifest, VisualImageAdmissionResult,
    admit_visual_image_request, assert_visual_carrier_matches_catalog,
    image_admission_for_catalog_entry, sanitize_image, verify_visual_manifest_source,
};
pub use memory_source::{MemorySourceCandidate, MemorySourceReferencePort, ResolvedMemorySource};
pub use pdf::{PdfTextError, extract_pdf_text, pdf_sidecar_text};
pub use prompt::*;
pub(crate) use recent::{RecentConversationInput, include_recent_context};
pub use round_projection::ContextPortAdapter;
pub(crate) use status::evaluate_status_budget;
pub(crate) use status_conversation::TranscriptScanError;
pub use status_conversation::{
    StatusConversationSummary, StatusFact, StatusTranscriptSummary, read_status_conversation_facts,
    read_status_transcript_summary,
};
pub(crate) use status_transcript_activity::{
    StatusTranscriptActivity, StatusTranscriptToolUsageBucket, TranscriptActivityCache,
};
pub(crate) use tool_artifact_slice::{ExactText, ToolArtifactTextSlice};
pub use tool_output::{
    ArtifactStream, BudgetToolOutputInput, BudgetedToolOutput, OutputModeInput,
    PruneMetricObserver, PruneToolOutputInput, PruneToolOutputResult, ReadToolEvidenceInput,
    ReadToolOutputInput, ShellCommandResult, ToolOutput, ToolOutputIdentity,
};

pub type ContextResult<T> = Result<T, ContextError>;

#[cfg(test)]
mod tests;
