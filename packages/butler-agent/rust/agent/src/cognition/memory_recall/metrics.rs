//! Request-bound, hash-only operational metric projection.

use sha2::{Digest, Sha256};

#[derive(Clone, Copy)]
pub(super) struct Executed {
    pub graph: bool,
    pub vector: bool,
    pub lexical: bool,
    pub context: bool,
}

pub(super) struct Candidate {
    pub episode_id: String,
    pub candidate_score: f64,
    pub g_rank: f64,
    pub g_score: f64,
    pub v_rank: f64,
    pub v_ann_distance: Option<f64>,
    pub l_rank: f64,
    pub l_score: f64,
    pub c_rank: f64,
    pub c_score: f64,
}

pub(crate) enum RecallMetric {
    Stage {
        name: &'static str,
        native_operation_sha256: String,
        duration_ms: f64,
    },
    CandidateRanking {
        native_operation_sha256: String,
        cue_sha256: String,
        generation_sha256: String,
        episode_sha256: String,
        candidate_rank: usize,
        candidate_score: f64,
        g_rank: f64,
        g_score: f64,
        v_rank: f64,
        v_ann_distance: Option<f64>,
        l_rank: f64,
        l_score: f64,
        c_rank: f64,
        c_score: f64,
        graph_executed: bool,
        vector_executed: bool,
        lexical_executed: bool,
        context_executed: bool,
    },
    ReturnedRanking {
        native_operation_sha256: String,
        cue_sha256: String,
        generation_sha256: String,
        episode_sha256: String,
        candidate_rank: usize,
        returned_rank: usize,
        graph_executed: bool,
        vector_executed: bool,
        lexical_executed: bool,
        context_executed: bool,
    },
}

pub(crate) trait RecallMetricSink: Send + Sync {
    fn record(&self, metric: RecallMetric);
}

pub(super) fn sha(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub(super) fn candidate(
    input: &crate::cognition::recall::RecallRequest,
    generation: &str,
    rank: usize,
    value: &Candidate,
    executed: Executed,
) -> RecallMetric {
    RecallMetric::CandidateRanking {
        native_operation_sha256: sha(&input.runtime.native_operation_id),
        cue_sha256: sha(&input.cue),
        generation_sha256: sha(generation),
        episode_sha256: sha(&value.episode_id),
        candidate_rank: rank,
        candidate_score: value.candidate_score,
        g_rank: value.g_rank,
        g_score: value.g_score,
        v_rank: value.v_rank,
        v_ann_distance: value.v_ann_distance,
        l_rank: value.l_rank,
        l_score: value.l_score,
        c_rank: value.c_rank,
        c_score: value.c_score,
        graph_executed: executed.graph,
        vector_executed: executed.vector,
        lexical_executed: executed.lexical,
        context_executed: executed.context,
    }
}

pub(super) fn returned(
    input: &crate::cognition::recall::RecallRequest,
    generation: &str,
    candidate_rank: usize,
    returned_rank: usize,
    episode_id: &str,
    executed: Executed,
) -> RecallMetric {
    RecallMetric::ReturnedRanking {
        native_operation_sha256: sha(&input.runtime.native_operation_id),
        cue_sha256: sha(&input.cue),
        generation_sha256: sha(generation),
        episode_sha256: sha(episode_id),
        candidate_rank,
        returned_rank,
        graph_executed: executed.graph,
        vector_executed: executed.vector,
        lexical_executed: executed.lexical,
        context_executed: executed.context,
    }
}
