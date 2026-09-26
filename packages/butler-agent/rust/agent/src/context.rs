//! Bounded conversation context compilation and model-aware budget policy.

mod attachment;
mod budget;
mod compaction;
mod conversation;
mod conversation_session_reference;
mod conversation_tools;
mod image;
mod memory_source;
mod pdf;
mod prompt;
mod recent;
mod round_projection;
#[cfg(unix)]
mod status;
mod status_conversation;
mod status_transcript_activity;
mod tool_artifact_slice;
mod tool_output;

pub(crate) use crate::conversation::text_for_message;
pub(crate) use attachment::NativeAttachmentContext;
pub(crate) use budget::*;
pub(crate) use compaction::{
    CompactionMetricEvent, ContextCompactionMetricSink, compact_transcript,
    compaction_snapshot_path,
};
pub(crate) use conversation::*;
pub(crate) use conversation_session_reference::NativeConversationSessionReference;
pub(crate) use conversation_tools::NativeConversationTools;
pub(crate) use image::{
    ImageCapabilityEvidence, ImageCarrierTuple, ImageSanitizerInput, ImageSanitizerLimits,
    ImageSourceRecord, VisualAttachmentManifest, VisualImageAdmissionResult,
    admit_visual_image_request, assert_visual_carrier_matches_catalog,
    image_admission_for_catalog_entry, sanitize_image, verify_visual_manifest_source,
};
pub(crate) use memory_source::{
    MemorySourceCandidate, MemorySourceReferencePort, ResolvedMemorySource,
};
pub(crate) use pdf::{PdfTextError, extract_pdf_text, pdf_sidecar_text};
pub(crate) use prompt::*;
pub(crate) use recent::{RecentConversationInput, include_recent_context};
pub(crate) use round_projection::NativeContextPort;
#[cfg(unix)]
pub(crate) use status::evaluate_status_budget;
pub(crate) use status_conversation::{
    StatusConversationSummary, StatusFact, StatusTranscriptSummary, read_status_conversation_facts,
    read_status_transcript_summary,
};
pub(crate) use status_transcript_activity::{
    StatusTranscriptToolUsageBucket, read_status_transcript_activity,
};
pub(crate) use tool_artifact_slice::{ExactText, ToolArtifactTextSlice};
pub(crate) use tool_output::{
    ArtifactStream, BudgetToolOutputInput, BudgetedToolOutput, NativeToolOutput, OutputModeInput,
    PruneMetricObserver, PruneToolOutputInput, PruneToolOutputResult, ReadToolEvidenceInput,
    ReadToolOutputInput, ShellCommandResult, ToolOutputIdentity,
};

use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ContextError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl ContextError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for ContextError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ContextError {}

pub(crate) type ContextResult<T> = Result<T, ContextError>;

#[cfg(test)]
mod tests;
