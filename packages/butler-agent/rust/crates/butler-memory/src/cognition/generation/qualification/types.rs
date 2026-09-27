use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub(super) struct Acceptance {
    pub schema: String,
    pub verification_generation_id: String,
    pub verification_source_inventory_hash: String,
    pub implementation_commit: String,
    pub tool_contract_version: u32,
    pub extraction_version: String,
    pub embedding_version: String,
    pub cases: Vec<AcceptanceCase>,
    pub performance: PerformanceAcceptance,
}

#[derive(Debug, Deserialize)]
pub(super) struct AcceptanceCase {
    pub id: String,
    pub mr_ids: Vec<String>,
    pub query_hash: String,
    pub source_refs: Vec<String>,
    pub expected_source_refs: Vec<String>,
    pub observed_source_refs: Vec<String>,
    pub outcome: String,
    pub path: String,
    pub uses_real_extractor: bool,
    pub uses_real_embedding: bool,
    pub trace_ref: String,
    pub trace_sha256: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct PerformanceAcceptance {
    pub prepared_graph_p95_ms: f64,
    pub prepared_hybrid_p95_ms: f64,
    pub graph_samples: usize,
    pub hybrid_samples: usize,
    pub report_ref: String,
    pub report_sha256: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct EvidenceRef {
    #[serde(rename = "ref")]
    pub ref_: String,
    pub sha256: String,
    #[serde(default)]
    pub result_id: Option<String>,
}

impl EvidenceRef {
    pub(super) fn path(&self) -> &str {
        &self.ref_
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct CaseTrace {
    pub schema: String,
    pub execution: Execution,
    pub query: TraceQuery,
    pub qualification_source_inventory_hash: String,
    pub qualification_source_inventory_ref: String,
    pub qualification_source_inventory_sha256: String,
    pub source_observations: Vec<SourceObservation>,
    pub completion_ids: Vec<String>,
    pub projection_job_ids: Vec<String>,
    pub native_result_ids: Vec<String>,
    #[serde(default)]
    pub owner_result_refs: Option<Vec<EvidenceRef>>,
    #[serde(default)]
    pub owner_source_result_refs: Option<Vec<EvidenceRef>>,
    #[serde(default)]
    pub owner_route: Option<String>,
    #[serde(default)]
    pub supporting_execution_refs: Option<Vec<EvidenceRef>>,
    pub extractor_attempt_refs: Vec<EvidenceRef>,
    pub embedding_receipt_refs: Vec<EvidenceRef>,
    pub expected_source_handles: Vec<String>,
    pub expected_source_groups: Vec<Vec<String>>,
    pub observed_source_handles: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct Execution {
    pub generation_id: String,
    pub implementation_commit: String,
    pub tool_contract_version: u32,
    pub extraction_version: String,
    pub embedding: EmbeddingExecution,
    pub stage_source_inventory_hash: String,
    pub source_inventory_ref: String,
    pub source_inventory_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(super) enum EmbeddingExecution {
    Executed { version: String },
    NotExecuted { reason: String },
}

#[derive(Debug, Deserialize)]
pub(super) struct TraceQuery {
    pub sha256: String,
    #[serde(default)]
    pub request_id: Option<String>,
    pub result_refs: Vec<EvidenceRef>,
}

#[derive(Debug, Deserialize)]
pub(super) struct SourceObservation {
    pub handle: String,
    pub identity: SourceIdentity,
    pub revision: String,
    pub source_hash: String,
    pub observed_at: String,
    pub currentness: String,
    pub inventory_hash: String,
    pub binding_ref: String,
    pub binding_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(super) enum SourceIdentity {
    MemorySource {
        source_id: String,
    },
    ConversationSource {
        message_id: String,
        part_id: String,
        scalar_pointer: String,
    },
}

#[derive(Debug, Deserialize)]
pub(super) struct QueryResult {
    pub schema: String,
    pub request_id: String,
    pub result_id: String,
    pub generation_id: String,
    pub query_hash: String,
    pub status: String,
    pub source_handles: Vec<String>,
    pub observations: Vec<QueryObservation>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(super) enum QueryObservation {
    SourceRef { source_ref: String },
    SessionMessage { message_id: String },
}

#[derive(Debug, Deserialize)]
pub(super) struct OwnerResult {
    pub schema: String,
    pub result_id: String,
    pub generation_id: String,
    pub status: String,
    pub source_handles: Vec<String>,
    pub observations: Vec<QueryObservation>,
}

#[derive(Debug, Deserialize)]
pub(super) struct SourceBinding {
    pub schema: String,
    pub handle: String,
    pub observation_kind: String,
    #[serde(default)]
    pub returned_source_ref: Option<String>,
    #[serde(default)]
    pub returned_message_id: Option<String>,
    pub generation_id: String,
    pub inventory_hash: String,
    pub revision: String,
    pub source_hash: String,
    pub observed_at: String,
    pub currentness: String,
    pub returned_in_result_id: String,
    pub read_result_ref: String,
    pub read_result_sha256: String,
    #[serde(default)]
    pub source_row: Option<SourceRow>,
    #[serde(default)]
    pub chunk: Option<SourceChunk>,
    #[serde(default)]
    pub split_ancestry: Option<Vec<SplitAncestor>>,
    #[serde(default)]
    pub canonical: Option<CanonicalSource>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
pub(super) struct SourceRow {
    pub source_id: String,
    pub episode_id: String,
    pub revision: String,
    pub content_hash: String,
    #[serde(default)]
    pub conversation_session_id: Option<String>,
    #[serde(default)]
    pub conversation_message_id: Option<String>,
    #[serde(default)]
    pub part_id: Option<String>,
    #[serde(default)]
    pub scalar_pointer: Option<String>,
    pub byte_start: i64,
    pub byte_end: i64,
    pub observed_at: String,
    pub conversation_start: String,
    pub conversation_end: String,
    #[serde(default)]
    pub project_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct SourceChunk {
    pub current_revision: String,
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct SplitAncestor {
    pub source_id: String,
    pub episode_id: String,
    pub revision: String,
    pub content_hash: String,
    #[serde(default)]
    pub conversation_session_id: Option<String>,
    #[serde(default)]
    pub conversation_message_id: Option<String>,
    #[serde(default)]
    pub part_id: Option<String>,
    #[serde(default)]
    pub scalar_pointer: Option<String>,
    pub byte_start: i64,
    pub byte_end: i64,
    pub child_source_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct CanonicalSource {
    pub message_id: String,
    pub part_id: String,
    pub scalar_pointer: String,
    pub scalar_hash: String,
    pub revision: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct SourceRead {
    pub schema: String,
    pub result_id: String,
    pub observation_kind: String,
    #[serde(default)]
    pub source_ref: Option<String>,
    #[serde(default)]
    pub message_id: Option<String>,
    pub canonical: ReadCanonical,
    pub returned_text: String,
    pub source_row: SourceRow,
}

#[derive(Debug, Deserialize)]
pub(super) struct ReadCanonical {
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub part_id: Option<String>,
    #[serde(default)]
    pub scalar_pointer: Option<String>,
    pub text: String,
    pub bytes: u64,
    pub sha256: String,
    pub revision: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct PerformanceReport {
    pub schema: String,
    pub execution: PerformanceExecution,
    pub samples: Vec<PerformanceSample>,
    pub contention: ContentionEvidence,
}

#[derive(Debug, Deserialize)]
pub(super) struct PerformanceExecution {
    pub generation_id: String,
    pub implementation_commit: String,
    pub embedding_version: String,
    pub qualification_source_inventory_hash: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct PerformanceSample {
    pub mode: String,
    pub query_id: String,
    pub repetition: u32,
    pub result_id: String,
    pub result_ref: String,
    pub result_sha256: String,
    pub metrics_ref: String,
    pub metrics_sha256: String,
    pub query_hash: String,
    pub status: String,
    pub elapsed_ms: f64,
    pub expected_source_groups: Vec<Vec<String>>,
    pub observed_source_handles: Vec<String>,
    pub source_binding_refs: Vec<EvidenceRef>,
    pub coverage_ok: bool,
}

#[derive(Debug, Deserialize)]
pub(super) struct PerformanceMetrics {
    pub schema: String,
    pub mode: String,
    pub query_id: String,
    pub repetition: u32,
    pub result_id: String,
    pub query_hash: String,
    pub status: String,
    pub elapsed_ms: f64,
}

#[derive(Debug, Deserialize)]
pub(super) struct ContentionEvidence {
    pub source_window_ids: Vec<String>,
    pub query_intervals: Vec<QueryInterval>,
    pub queue_work_refs: Vec<QueueWorkRef>,
    pub overlapped: bool,
}

#[derive(Debug, Deserialize)]
pub(super) struct QueryInterval {
    pub query_id: String,
    pub started_at: String,
    pub ended_at: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct QueueWorkRef {
    #[serde(flatten)]
    pub evidence: EvidenceRef,
    pub started_at: String,
    pub ended_at: String,
    pub result_id: String,
    pub source_window_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct QueueWorkEvidence {
    pub schema: String,
    pub result_id: String,
    pub source_window_ids: Vec<String>,
    pub started_at: String,
    pub ended_at: String,
    pub work_class: String,
}
