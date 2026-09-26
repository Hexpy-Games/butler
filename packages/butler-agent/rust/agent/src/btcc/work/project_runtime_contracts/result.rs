#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProjectWorkToolResultEvidence {
    pub tool_call_id: String,
    pub tool_name: String,
    pub status: &'static str,
    pub result_sha256: String,
    pub origin_turn_id: String,
    pub source_turn_rowid: Option<i64>,
    pub source_turn_sequence: Option<i64>,
}
