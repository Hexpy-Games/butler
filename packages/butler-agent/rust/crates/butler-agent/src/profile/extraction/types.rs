use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;

use crate::models::PromptUsageReport;

use super::super::contracts::ProfileModelUsageSummary;

pub(super) const EXTRACTOR_VERSION: &str = "profile-scalar-v1";
pub(super) const MAX_SCAN_MESSAGES: usize = 20_000;
pub(super) const MAX_OBSERVATIONS: usize = 160;
pub(super) const PROMPT_BYTES: usize = 24 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub(super) struct SourceWindow {
    pub text: Arc<str>,
    pub evidence_ref: String,
    pub timestamp: String,
    pub message_id: String,
    pub part_id: String,
    pub part_index: f64,
    pub scalar_pointer: String,
    pub source_hash: String,
    pub byte_start: usize,
    pub byte_end: usize,
    pub coverage_key: String,
}

#[derive(Clone, Debug)]
pub(super) struct SourceRead {
    pub scanned_session_count: usize,
    pub scanned_message_count: usize,
    pub windows: Vec<SourceWindow>,
    pub discovery_incomplete: bool,
    pub current_obligation_count: usize,
    pub stale_keys: Vec<String>,
    pub persistent_offset: Option<usize>,
}

#[derive(Clone, Debug)]
pub(super) struct ExtractedCandidate {
    pub payload: Value,
    pub category: String,
    pub source_type: String,
    pub confidence: String,
    pub sensitive_domain: bool,
    pub evidence_refs: Vec<String>,
    pub expires_or_decay: Option<String>,
}

#[derive(Clone, Debug)]
pub(super) struct CorrectionTarget {
    pub stable_id: String,
    pub category: String,
    pub facet: Option<String>,
    pub applies_when: Vec<String>,
    pub revision: String,
}

#[derive(Clone, Debug)]
pub(super) struct CorrectionTargets {
    pub public: Vec<Value>,
    pub private: HashMap<String, CorrectionTarget>,
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct CoverageCounts {
    pub pending: usize,
    pub failed: usize,
    pub complete: usize,
}

pub(super) fn add_usage(
    summary: &mut ProfileModelUsageSummary,
    requested_model: &str,
    usage: Option<&PromptUsageReport>,
) {
    summary.request_count += 1.0;
    let model = usage
        .map(|value| value.model.as_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(requested_model);
    if !model.is_empty() && !summary.models.iter().any(|value| value == model) {
        summary.models.push(model.to_owned());
    }
    let Some(usage) = usage else { return };
    if let Some(prompt) = usage.prompt_tokens {
        summary.prompt_tokens += prompt;
        summary.cached_input_tokens += usage.cached_tokens.min(prompt);
        summary.uncached_input_tokens += (prompt - usage.cached_tokens).max(0.0);
    }
    if let Some(total) = usage.total_tokens {
        summary.total_tokens += total;
        if let Some(prompt) = usage.prompt_tokens {
            summary.output_tokens += (total - prompt).max(0.0);
        }
    }
}
